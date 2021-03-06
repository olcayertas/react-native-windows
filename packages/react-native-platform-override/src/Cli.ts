/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT License.
 *
 * @format
 */

import * as Api from './Api';

import * as _ from 'lodash';
import * as chalk from 'chalk';
import * as ora from 'ora';
import * as path from 'path';
import * as yargs from 'yargs';

import {overrideFromDetails, promptForOverrideDetails} from './OverridePrompt';

import CrossProcessLock from './CrossProcessLock';
import {UpgradeResult} from './UpgradeStrategy';
import {ValidationError} from './ValidationStrategy';
import {findManifest} from './FileSearch';
import {getNpmPackage} from './PackageUtils';

doMain(async () => {
  const npmPackage = await getNpmPackage();

  return new Promise((resolve, _reject) => {
    yargs
      .command(
        'validate',
        'Verify that overrides are recorded and up-to-date',
        cmdYargs =>
          cmdYargs.options({
            manifest: {
              type: 'string',
              describe: 'Optional path to the override manifest to validate',
            },
            version: {
              type: 'string',
              describe: 'Optional React Native version to check against',
            },
          }),
        cmdArgv =>
          validateManifest({
            manifestPath: cmdArgv.manifest,
            reactNativeVersion: cmdArgv.version,
          }),
      )
      .command(
        'add <override>',
        'Add an override to the manifest',
        cmdYargs =>
          cmdYargs.options({
            override: {type: 'string', describe: 'The override to add'},
          }),
        cmdArgv => addOverride(cmdArgv.override!),
      )
      .command(
        'remove <override>',
        'Remove an override from the manifest',
        cmdYargs =>
          cmdYargs.options({
            override: {type: 'string', describe: 'The override to remove'},
          }),
        cmdArgv => removeOverride(cmdArgv.override!),
      )
      .command(
        'upgrade',
        'Attempts to automatically merge new changes into out-of-date overrides',
        cmdYargs =>
          cmdYargs.options({
            manifest: {
              type: 'string',
              describe: 'Optional path to the override manifests to validate',
            },
            conflicts: {
              type: 'boolean',
              default: true,
              describe: 'Whether to allow merge conflicts to be written',
            },
            version: {
              type: 'string',
              describe: 'Optional React Native version to check against',
            },
          }),
        cmdArgv =>
          upgrade({
            manifestPath: cmdArgv.manifest,
            reactNativeVersion: cmdArgv.version,
            allowConflicts: cmdArgv.conflicts,
          }),
      )
      .epilogue(npmPackage.description)
      .option('color', {hidden: true})
      .demandCommand()
      .recommendCommands()
      .strict()
      .showHelpOnFail(false)
      .wrap(yargs.terminalWidth())
      .version(false)
      .scriptName(npmPackage.name)
      .onFinishCommand(resolve).argv;
  });
});

/**
 * Check that the given manifest correctly describe overrides and that all
 * overrides are up to date
 */
async function validateManifest(opts: {
  manifestPath?: string;
  reactNativeVersion?: string;
}) {
  const spinner = ora(`Validating overrides`).start();

  await spinnerGuard(spinner, async () => {
    const validationErrors = await Api.validateManifest(opts);

    if (validationErrors.length === 0) {
      spinner.succeed();
    } else {
      spinner.fail();
      await printValidationErrors(validationErrors);
      process.exitCode = 1;
    }
  });
}

/**
 * Add an override to the manifest
 */
async function addOverride(overridePath: string) {
  const manifestPath = await findManifest(path.dirname(overridePath));
  const manifestDir = path.dirname(manifestPath);
  const overrideName = path.relative(manifestDir, path.resolve(overridePath));

  if (await Api.hasOverride(overrideName, {manifestPath})) {
    console.warn(
      chalk.yellow(
        'Warning: override already exists in manifest and will be overwritten',
      ),
    );
  }

  const overrideDetails = await promptForOverrideDetails();

  const spinner = ora('Adding override').start();
  await spinnerGuard(spinner, async () => {
    const override = await overrideFromDetails(
      overridePath,
      overrideDetails,
      await Api.getOverrideFactory({manifestPath}),
    );

    await Api.removeOverride(overrideName, {manifestPath});
    await Api.addOverride(override, {manifestPath});
    spinner.succeed();
  });
}

/**
 * Remove an override from the manifest
 */
async function removeOverride(overridePath: string) {
  const manifestPath = await findManifest(path.dirname(overridePath));
  const manifestDir = path.dirname(manifestPath);
  const overrideName = path.relative(manifestDir, path.resolve(overridePath));

  if (await Api.removeOverride(overrideName, {manifestPath})) {
    console.log(chalk.greenBright('Override successfully removed'));
  } else {
    console.error(
      chalk.red('Could not remove override. Is it part of the manifest?'),
    );
    process.exit(1);
  }
}

/**
 * Attempts to automatically merge changes from the current version into
 * out-of-date overrides.
 */
async function upgrade(opts: {
  manifestPath?: string;
  reactNativeVersion?: string;
  allowConflicts: boolean;
}) {
  const spinner = ora('Merging overrides').start();
  await spinnerGuard(spinner, async () => {
    const upgradeResults = await Api.upgradeOverrides({
      ...opts,
      progressListener: (currentOverride, totalOverrides) =>
        (spinner.text = `Merging overrides (${currentOverride}/${totalOverrides})`),
    });

    spinner.succeed();
    printUpgradeStats(upgradeResults, opts.allowConflicts);
  });
}

/**
 * Print statistics about an attempt to upgrade out-of-date-overrides.
 */
function printUpgradeStats(
  results: Array<UpgradeResult>,
  allowConflicts: boolean,
) {
  const numTotal = results.length;
  const numConflicts = results.filter(res => res.hasConflicts).length;
  const numAutoPatched = numTotal - numConflicts;

  if (numTotal === 0) {
    console.log(chalk.greenBright('No out-of-date overrides detected'));
  } else {
    console.log(
      chalk.greenBright(
        `${numAutoPatched}/${numTotal} out-of-date overrides automatically merged`,
      ),
    );
  }
  if (allowConflicts && numConflicts > 0) {
    console.log(
      chalk.yellowBright(`${numConflicts} overrides require manual resolution`),
    );
  }
}

/**
 * Prints validation errors in a user-readable form to stderr
 */
async function printValidationErrors(validationErrors: Array<ValidationError>) {
  if (validationErrors.length === 0) {
    return;
  }

  const npmPackage = await getNpmPackage();
  const errors = _.clone(validationErrors);

  // Add an initial line of separation
  console.error();

  printErrorType(
    'missingFromManifest',
    errors,
    `Found override files that aren't listed in the manifest. Overrides can be added to the manifest by using 'npx ${
      npmPackage.name
    } add <override>':`,
  );

  printErrorType(
    'overrideNotFound',
    errors,
    `Found overrides in the manifest that don't exist on disk. Remove existing overrides using 'npx ${
      npmPackage.name
    } remove <override>':`,
  );

  printErrorType(
    'baseNotFound',
    errors,
    `Found overrides whose base files do not exist. Remove existing overrides using 'npx ${
      npmPackage.name
    } remove <override>':`,
  );

  printErrorType(
    'outOfDate',
    errors,
    `Found overrides whose original files have changed. Upgrade overrides using 'npx ${
      npmPackage.name
    } upgrade:`,
  );

  printErrorType(
    'overrideDifferentFromBase',
    errors,
    'The following overrides should be an exact copy of their base files. Ensure overrides are up to date or revert changes:',
  );

  printErrorType(
    'overrideSameAsBase',
    errors,
    'The following overrides are identical to their base files. Please remove them or set their type to "copy":',
  );

  printErrorType(
    'expectedFile',
    errors,
    'The following overrides should operate on files, but list directories:',
  );

  printErrorType(
    'expectedDirectory',
    errors,
    'The following overrides should operate on directories, but listed files:',
  );

  if (errors.length !== 0) {
    throw new Error('Unprinted errors present:\n' + errors);
  }
}

/**
 * Print validation errors of a speccific type
 */
function printErrorType(
  type: ValidationError['type'],
  errors: ValidationError[],
  message: string,
) {
  const filteredErrors = _.remove(errors, err => err.type === type);
  filteredErrors.sort((a, b) =>
    a.overrideName.localeCompare(b.overrideName, 'en'),
  );

  if (filteredErrors.length > 0) {
    console.error(chalk.red(message));
    filteredErrors.forEach(err => console.error(` - ${err.overrideName}`));
    console.error();
  }
}

/**
 * Wraps the function in a try/catch, failing the spinner if an exception is
 * thrown to allow unmangled output
 */
async function spinnerGuard<T>(
  spinner: ora.Ora,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (ex) {
    if (spinner.isSpinning) {
      spinner.fail();
    }
    throw ex;
  }
}

/**
 * Wrap the main function around a barrier to ensure only one copy of the
 * override tool is running at once. This is needed to avoid multiple tools
 * accessing the same local Git repo at the same time.
 */
async function doMain(fn: () => Promise<void>): Promise<void> {
  const lock = new CrossProcessLock(`${(await getNpmPackage()).name}-cli-lock`);

  if (!(await lock.tryLock())) {
    const spinner = ora(
      'Waiting for other instances of the override CLI to finish',
    ).start();
    await lock.lock();
    spinner.stop();
  }

  await fn();
  lock.unlock();
}
