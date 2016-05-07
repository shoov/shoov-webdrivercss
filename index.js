'use strict';

var Promise = require('bluebird');
var exec = require('child_process').exec;
var fs = Promise.promisifyAll(require('fs'));
var git = require('git-rev');
var nconf = require('nconf');
var open = require('open');
var path = require('path');
var R = require('ramda');
var request = require('request-promise');
var WebdriverCSS = require('webdrivercss');
var WebdriverIO = require('webdriverio');


var uploads = [];

var client = {};

// The images tath were processed.
var processedRes = [];

// @todo: Get this info from the "uploads" variable.
var buildId;

var gitCommit;
var gitBranch;

git.long(function (str) {
  gitCommit = str;
});

git.branch(function (str) {
  gitBranch = str;
});

/**
 * Get the commit subject.
 */
var gitSubject = new Promise(function(resolve, reject) {
  exec('git log HEAD -1 --format=%s', function(err, stdout) {
    if(err) {
      reject(err);
    }
    else {
      resolve(stdout.replace('\n', ''));
    }
  });
});


/**
 * Get the directory prefix from the repository root.
 */
var gitPrefix = new Promise(function(resolve, reject) {
  exec('git rev-parse --show-prefix', function(err, stdout) {
    if(err) {
      reject(err);
    }
    else {
      resolve(stdout.replace('\n', ''));
    }
  });
});

var gitRepoName = new Promise(function(resolve, reject) {
  exec('git config --get remote.origin.url', function(err, stdout) {
    if(err) {
      reject(err);
    }
    else {
      // @todo: Be more careful with the assumptions about the URL
      var output = stdout
        .replace('\n', '')
        .replace('git@github.com:', '')
        .replace('https://github.com/', '')
        .replace(/https:\/\/.*@github.com\//i, '')
        .replace('git://github.com/', '')
        .replace('.git', '');

      resolve(output);
    }
  });
});

/**
 * Get config from file or environment.
 *
 * JSON file is in ~/.shoov.json
 *
 * @param str
 *   The config name.
 * @param defaultValue
 *   The default value.
 * @param bool addPrefix
 *   Determins if the "SHOOV_" prefix should be added to the variable. Defaults
 *   to TRUE.
 *
 *
 * @returns {*}
 */
var getConfig = function(str, defaultValue, addPrefix) {
  // Set config hierarchy.
  var configFile = process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'] + '/.shoov.json';
  nconf
    .env()
    .file(configFile);

  addPrefix = addPrefix == false ? addPrefix : true;

  var prefix = !!addPrefix ? 'SHOOV_' : '';

  var upperCase = prefix + str.toUpperCase();
  var confValue = nconf.get(str) || nconf.get(upperCase);
  return confValue || defaultValue;
};

/**
 * Upload the image.
 *
 * @param obj
 */
var uploadFailedImage = function(obj) {
  var accessToken = getConfig('access_token');
  if (!accessToken) {
    throw new Error('The Shoov access token is not defined, visit your account page.');
  }

  var backendUrl = getConfig('backend_url', 'https://live-shoov.pantheonsite.io');
  var options = {
    url: backendUrl + '/api/screenshots-upload',
    headers: {
      'access-token': accessToken
    }
  };

  var gitData = {
    gitSubject: gitSubject,
    gitPrefix: gitPrefix,
    gitRepoName: gitRepoName
  };

  var uploadResponse = '';

  Promise.props(gitData)
    .then(function(gitData) {
      var req = request.post(options);
      req
        .on('error', function (err) {
          throw new Error(err);
        })
        .on('data', function(chunk) {
          uploadResponse += chunk;
        })
        .on('end', function() {
          var data = JSON.parse(uploadResponse).data[0];
          // Populate the build ID.
          buildId = buildId || data.build;

          if (getConfig('debug')) {
            // Show response.
            console.log(data);
          }
        })
        .on('response', function(response) {
          if (response.statusCode >= 500) {
            throw new Error('Backend error');
          }
          else if (response.statusCode !== 200) {
            throw new Error('Access token is incorrect or no longer valid, visit your account page');
          }
        });

      var form = req.form();

      var label = path.basename(obj.baselinePath, '.baseline.png').replace('.', ' ');
      form.append('label', label);

      form.append('baseline', fs.createReadStream(obj.baselinePath));
      form.append('regression', fs.createReadStream(obj.regressionPath));
      form.append('diff', fs.createReadStream(obj.diffPath));

      form.append('baseline_name', obj.baselinePath);
      form.append('git_commit', gitCommit);
      form.append('git_branch', gitBranch);
      form.append('git_subject', gitData.gitSubject);

      form.append('directory_prefix', gitData.gitPrefix);
      form.append('repository', gitData.gitRepoName);

      form.append('tags', obj.properties.tags ? obj.properties.tags.join(',') : '');

      uploads.push(req);
    });

  throw new Error('Found regression in test');
};

var wdcssSetup = {

  /**
   * Return the test name based on the caps configuration and env prefix.
   */
  getTestName: function(capsConfig) {
    var selectedCaps = process.env.SELECTED_CAPS || undefined;
    var caps = selectedCaps ? capsConfig[selectedCaps] : undefined;

    var providerPrefix = process.env.PROVIDER_PREFIX ? process.env.PROVIDER_PREFIX + '-' : '';
    return selectedCaps ? providerPrefix + selectedCaps : providerPrefix + 'default';
  },

  /**
   * Init the client.
   */
  before: function(done, caps) {
    client = this.getClient(done, caps);
    WebdriverCSS.init(client);

    return client;
  },

  after: function(done) {
    return Promise
      .all(uploads)
      .then(function() {
        if (uploads.length) {
          var clientUrl = getConfig('client_url', 'https://app.shoov.io');
          var regressionUrl = clientUrl + '/#/screenshots/' + buildId;
          console.log('See regressions in: ' + regressionUrl);

          if (getConfig('open_link')) {
            open(regressionUrl)
          }
        }

        client.end(done);
      });
  },

  processResults: function(err, res) {
    if (err) {
      console.error(err);
    }

    // @todo: Convert to Ramda.
    // Keep only images that were not processed yet.
    var newRes = {};
    Object.keys(res).forEach(function(key) {
      if (processedRes.indexOf(key) == -1) {
        var val = res[key];
        newRes[key] = val;
        processedRes.push(key);
      }
    });

    var isNotWithinMisMatchTolerance = R.filter(R.where({isWithinMisMatchTolerance: false}));
    var uploadImages = R.mapObj(R.forEach(uploadFailedImage));
    var checkImages = R.compose(uploadImages, R.mapObj(isNotWithinMisMatchTolerance));

    checkImages(newRes);
  },

  getUploadedRequests: function() {
    return uploads;
  },

  /**
   * Get client.
   *
   * @param done
   *   Mocha's done callback.
   * @param capsConfig
   *   The capabilities configuration. If empty, default one will be used.
   */
  getClient : function (done, caps) {
    caps = caps || {};

    var capsProvided = !!Object.keys(caps).length;

    // We follow the naming conventions of the username and key, as proivded by
    // the different service providers.
    var sauceUserName = getConfig('sauce_username', false, false);
    var sauceAccessKey = getConfig('sauce_access_key', false, false);

    var browserStackUserName = getConfig('browserstack_username', false, false);
    var browserStackKey = getConfig('browserstack_key', false, false);

    if (sauceUserName && sauceAccessKey) {
      if (!capsProvided) {
        // Set default capabilities.
        caps['browserName'] = 'chrome';
        caps['platform'] = 'Linux';
        caps['version'] = '41.0';
        caps['screenResolution'] = '1024x768';
      }

      client = WebdriverIO.remote({
        desiredCapabilities: caps,
        host: 'ondemand.saucelabs.com',
        port: 80,
        user: sauceUserName,
        key: sauceAccessKey
      });
    }
    else if (browserStackUserName && browserStackKey) {
      if (!capsProvided) {
        // Set default capabilities.
        caps['browser'] = 'Chrome';
        caps['browser_version'] = '39.0';
        caps['os'] = 'OS X';
        caps['os_version'] = 'Yosemite';
        caps['resolution'] = '1024x768';
      }

      caps['browserstack.user'] = browserStackUserName;
      caps['browserstack.key'] = browserStackKey;
      caps['browserstack.debug'] = 'true';

      client = WebdriverIO.remote({
        desiredCapabilities: caps,
        host: 'hub.browserstack.com',
        port: 80
      });
    }
    else {
      client = WebdriverIO.remote({ desiredCapabilities: {browserName: 'phantomjs'} });
    }

    // Init the client.
    client.init(done);

    var width;
    var height;

    if (capsProvided && caps.resolution) {
      var size = caps.resolution.split('x');
      width = parseInt(size[0]);
      height = parseInt(size[1]);
    }

    width = width || 1024;
    height = height || 768;

    client.setViewportSize({
      width: width,
      height: height
    });

    return client;
  }
};

module.exports = wdcssSetup;
