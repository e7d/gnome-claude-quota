#!/usr/bin/env node
import {appendFileSync, readFileSync, readdirSync} from 'node:fs';
import {basename, join} from 'node:path';
import {argv, env, exit} from 'node:process';

import {buildReport} from './lib/ci-report.js';

const SHARD_LOG = /^e2e-(.+)\.log$/;

function option(name) {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
}

function listing(dir) {
    try {
        return readdirSync(dir, {recursive: true}).map(String);
    } catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
}

function shardLogs(dir) {
    return listing(dir).filter(entry => SHARD_LOG.test(basename(entry)))
        .map(entry => ({
            name: SHARD_LOG.exec(basename(entry))[1],
            text: readFileSync(join(dir, entry), 'utf8'),
        }));
}

const report = buildReport({
    shards: shardLogs(option('--reports') ?? 'reports'),
    needs: JSON.parse(option('--needs') ?? '{}'),
});
process.stdout.write(report.markdown);
if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, report.markdown);
exit(report.ok ? 0 : 1);
