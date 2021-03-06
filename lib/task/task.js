// Copyright 2017 ODK Central Developers
// See the NOTICE file at the top-level directory of this distribution and at
// https://github.com/opendatakit/central-backend/blob/master/NOTICE.
// This file is part of ODK Central. It is subject to the license terms in
// the LICENSE file found in the top-level directory of this distribution and at
// https://www.apache.org/licenses/LICENSE-2.0. No part of ODK Central,
// including this file, may be copied, modified, propagated, or distributed
// except according to the terms contained in the LICENSE file.
//
// Tasks are just a way of standardizing different computing constructions into
// a single container format and runner system. In the end, they're just Promises
// like anything else.
//
// Ultimately, they serve as a way of running application code outside the context
// of the full application, on the command line, and standardizing command-line
// output.

const { promisify, inspect } = require('util');
const { merge, compose } = require('ramda');
const config = require('config');
const Problem = require('../util/problem');
const Option = require('../util/option');
const { connect } = require('../model/database');
const pkg = require('../model/package');
const { serialize } = require('../util/http');
const crypto = require('../util/crypto');


////////////////////////////////////////////////////////////////////////////////
// TASK GENERATION
// If a task that requires a container context is run (.then is called on it)
// then we spawn a container and use that for all subsequent dependents. Unlike
// in the application, tasks are independent and share no state or transactions.
//
// We also provide a quick shortcut to promisify. If you have a function that
// already returns a Promise[Resolve[Serializable]|Problem] then congratulations,
// it's already a task!

const task = {
  // not thread-safe! but we don't have threads..
  withContainer: (taskdef) => (...args) => {
    const needsContainer = (task._container == null);
    if (needsContainer) task._container = pkg.withDefaults({ db: connect(config.get('default.database')), crypto });

    const result = taskdef(task._container)(...args);

    // early return with a modified result chain if cleanup is needed:
    if (needsContainer) {
      const cleanup = (next) => (inner) => {
        task._container.db.destroy();
        delete task._container;
        return next(inner);
      };
      return result.then(cleanup(Promise.resolve.bind(Promise)), cleanup(Promise.reject.bind(Promise)));
    }

    // otherwise just return.
    return result;
  },
  noop: Promise.resolve(null),
  promisify
};


////////////////////////////////////////////////////////////////////////////////
// TASKRUNNER
// Essentially just does enough work to return command-line feedback.

// Some helper functions used below to format console output after the task completes.
const writeTo = (output) => (x) => output.write(`${x}\n`);
const writeToStderr = writeTo(process.stderr);
/* istanbul ignore next */
const fault = (error) => {
  // first print our error.
  if ((error != null) && (error.isProblem === true) && (error.httpCode < 500)) {
    writeToStderr(error.message);
    if (error.problemDetails != null)
      writeToStderr(inspect(error.problemDetails));
  } else {
    writeToStderr(inspect(error));
  }

  // then set a bad error code for exit.
  process.exitCode = 1;
};

// auditing() does its best to ensure that the result of the task is audit-logged.
// either logs a success or a failure with an attached error message. Takes
// action: String indicating the audit action and t: Task|(() => Task).
const auditLog = task.withContainer(({ Audit }) => (action, success, details) =>
  Audit.log(null, action, null, merge({ success }, details)));

const auditing = (action, t) => ((typeof t === 'function')
  ? auditing(action, t())
  : t.then(
    ((result) => auditLog(action, true, result).then(
      (() => Promise.resolve(result)),
      ((auditError) => {
        writeToStderr('Failed to audit-log task success message!');
        fault(auditError);
        return Promise.resolve(result);
      })
    )),
    ((error) => auditLog(action, false, Option.of(error).map(Problem.serializable).orNull()).then(
      (() => Promise.reject(error)),
      ((auditError) => {
        writeToStderr('Failed to audit-log task failure message!');
        fault(auditError);
        return Promise.reject(error);
      })
    ))
  ));

// Executes a task and writes the result of that task to stdout. Takes
// t: Task|(() => Task).
const run = (t) => ((typeof t === 'function')
  ? run(t())
  : t.then(compose(writeTo(process.stdout), inspect, serialize), fault));


module.exports = { task, auditing, run };

