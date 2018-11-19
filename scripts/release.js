/* global process require */

const chalk = require('chalk');
const child_process = require('child_process');
const minimist = require('minimist');
const standardVersion = require('standard-version');

const {execSync} = child_process;
const execSyncInherit = (cmd) => execSync(cmd, {stdio: 'inherit'});

const args = minimist(process.argv.slice(2));

const DEFAULT_UPSTREAM_REPO_BRANCH = 'master';
const DEFAULT_UPSTREAM_REPO_ORIGIN = 'origin';
const branch = args['repo-branch'] || DEFAULT_UPSTREAM_REPO_BRANCH;
const origin = args['repo-origin'] || DEFAULT_UPSTREAM_REPO_ORIGIN;

const distTag = args['npm-dist-tag'];
const dryRun = args['dry-run'];
const prerelease = args.prerelease;
const releaseAs = args['release-as'];
const sign = args.sign;

const log = (mark, strings) => console.log(mark, strings.join(' '));
const logError = (...str) => log(chalk.red('✘'), str);
const logInfo = (...str) => log(chalk.blue('ℹ'), str);
const logSuccess = (...str) => log(chalk.green('✔'), str);

logInfo(`Fetching from origin '${origin}' to read upstream version...`);
try {
  execSyncInherit(`git fetch ${origin}`);
} catch (e) {
  logError(`Couldn't fetch latest commits. Please check the error above.`);
  process.exit(1);
}

let localRef, originRef;
try {
  localRef = execSync(`git rev-parse ${branch}`).toString();
  originRef = execSync(`git rev-parse ${origin}/${branch}`).toString();
} catch (e) {
  logError(`Couldn't parse branches. Please check the error above.`);
  process.exit(1);
}

if (localRef !== originRef) {
  logError(
    `Local branch '${branch}' is not up to date with '${origin}/${branch}'.`,
    `Please update your local branch first.`
  );
  process.exit(1);
}

logSuccess(`Release branch is up to date with remote branch.`);

(async () => {
  try {
    await standardVersion({
      dryRun,
      prerelease,
      releaseAs,
      sign
    });

    console.log(chalk.blue('ℹ'), [
      `Publishing new Embark version on npm${dryRun ? ' (DRY RUN)' : ''}...`,
    ].join(' '));

    const npmPublishCommand = [
      `npm publish`,
      `${distTag ? ` --tag ${distTag}` : ''}`,
      `${dryRun ? ' --dry-run' : ''}`
    ].join('');

    try {
      execSyncInherit(npmPublishCommand);
      logSuccess(
        `Successfully published latest version${dryRun ? ' (DRY RUN)' : ''}.`
      );
    } catch (e) {
      logError(
        `Couldn't publish version on npm. Please check the error above.`
      );
      throw new Error();
    }

    if (!dryRun) {
      logInfo(
        `Pushing release commit to origin '${origin}' on branch '${branch}'...`
      );
      try {
        execSyncInherit(`git push --follow-tags ${origin} ${branch}`);
        logSuccess(`Successfully pushed release commit.`);
      } catch (e) {
        logError(`Couldn't push release commit. Please check the error above.`);
        throw new Error();
      }
    } else {
      logInfo(`This is a dry run. Nothing's being pushed.`);
    }

    logSuccess(`Woohoo! Done.`);
  } catch (e) {
    logError(
      `Stopping right here. Make sure to clean up commits and tags if needed.`
    );
    process.exit(1);
  }
})();
