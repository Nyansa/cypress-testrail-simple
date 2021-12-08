/// <reference types="cypress" />

// @ts-check
const debug = require('debug')('cypress-testrail-simple')
const got = require('got')
const {
  hasConfig,
  getTestRailConfig,
  getAuthorization,
  getTestRunId,
} = require('../src/get-config')
const FormData = require('form-data')
const fs = require('fs')

// If a test fails, the screenshot path is added as an attachment to the result.
async function uploadAttachmentToResult(testRailInfo, resultId, screenshotPath) {
  try {
    if (!fs.existsSync(screenshotPath)) {
      return;
    }
    const addResultsUrl = `${testRailInfo.host}/index.php?/api/v2/add_attachment_to_result/${resultId}`;
    const authorization = getAuthorization(testRailInfo);

    const form = new FormData();
    form.append('attachment', fs.createReadStream(screenshotPath));
    // @ts-ignore
    await got(addResultsUrl, {
      method: 'POST',
      headers: {
        ...form.getHeaders(),
        authorization,
      },
      body: form,
    });
  } catch(err) {
    debug('Attachment upload failed');
    console.log(err);
  }
}

async function sendTestResults(testRailInfo, runId, testResults, screenshotPath) {
  debug(
    'sending %d test results to TestRail for run %d',
    testResults.length,
    runId,
  )
  const addResultsUrl = `${testRailInfo.host}/index.php?/api/v2/add_results_for_cases/${runId}`
  const authorization = getAuthorization(testRailInfo)

  // @ts-ignore
  const json = await got(addResultsUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authorization,
    },
    json: {
      results: testResults,
    },
  }).json()

  if(Array.isArray(json) && json.length > 0) {
    const resultObj = json[0];
    const resultId = resultObj.id;
    if (screenshotPath) {
      await uploadAttachmentToResult(testRailInfo, resultId, screenshotPath);
    }
  }

  debug('TestRail response: %o', json)
}

/**
 * Registers the cypress-testrail-simple plugin.
 * @example
 *  module.exports = (on, config) => {
 *   require('cypress-testrail-simple/src/plugin')(on)
 *  }
 * @example
 *  Skip the plugin
 *  module.exports = (on, config) => {
 *   require('cypress-testrail-simple/src/plugin')(on, true)
 *  }
 * @param {Cypress.PluginEvents} on Event registration function from Cypress
 * @param {Boolean} skipPlugin If true, skips loading the plugin. Defaults to false
 */
function registerPlugin(on, skipPlugin = false) {
  if (skipPlugin === true) {
    debug('the user explicitly disabled the plugin')
    return
  }

  if (!hasConfig(process.env)) {
    debug('cypress-testrail-simple env variables are not set')
    return
  }

  const testRailInfo = getTestRailConfig()
  const runId = getTestRunId()
  if (!runId) {
    throw new Error('Missing test rail run ID')
  }

  // should we ignore test results if running in the interactive mode?
  // right now these callbacks only happen in the non-interactive mode

  // https://on.cypress.io/after-spec-api
  on('after:spec', (spec, results) => {
    debug('after:spec')
    debug(spec)
    debug(results)

    // find only the tests with TestRail case id in the test name
    const testRailResults = []
    let screenshotPath = "";
    results.tests.forEach((result) => {
      const testRailCaseReg = /C(\d+)\s/
      // only look at the test name, not at the suite titles
      const testName = result.title[result.title.length - 1]
      if (testRailCaseReg.test(testName)) {
        const caseId = parseInt(testRailCaseReg.exec(testName)[1]);
        const testRailResult = {
          case_id: caseId,
          // TestRail status
          // Passed = 1,
          // Blocked = 2,
          // Untested = 3,
          // Retest = 4,
          // Failed = 5,
          // TODO: map all Cypress test states into TestRail status
          // https://glebbahmutov.com/blog/cypress-test-statuses/
          status_id: result.state === 'passed' ? 1 : 5,
        }

        if(result.state !== "passed") {
          // If the test fails, attach the test title, body and displayError
          // messages as a comment to the test result.
          if(result && result.title && result.body && result.displayError) {
            testRailResult.comment = `
              Error Message: \n
              ${result.title.join("--")} failed.\n 
              Error body: \n
              ${result.body}.\n
              Error stacktrace: \n 
              ${result.displayError}`;
          }

          // Find the screenshot path for the failed test and store it to add
          // it as an attachment.
          if("screenshots" in results) {
            // @ts-ignore
            if(Array.isArray(results.screenshots)) {
              // @ts-ignore
              const screenshotObj = results.screenshots.find((screenshot) => {
                return screenshot.path.indexOf(`C${caseId}`) !== -1;
              });
              screenshotPath = screenshotObj.path;
            }
          }
        }

        testRailResults.push(testRailResult)
      }
    })
    if (testRailResults.length) {
      console.log('TestRail results in %s', spec.relative);
      const testResultTableOutput = testRailResults.map((testRailResultObj) => {
        return {
          case_id: testRailResultObj.case_id,
          status_id: testRailResultObj.status_id
        };
      });
      console.table(testResultTableOutput);
      return sendTestResults(testRailInfo, runId, testRailResults)
    }
  })
}

module.exports = registerPlugin
