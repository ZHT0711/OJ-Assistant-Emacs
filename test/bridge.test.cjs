'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createService, AccountVault } = require('../bridge.cjs');
const { writeJson } = require('../src/account/credentials.ts');

class MemoryVault {
    accounts = [];
    async list() { return this.accounts; }
    async save(account) { this.accounts = [account, ...this.accounts.filter(item => item.id !== account.id)]; }
}

async function temporary(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oj-emacs-中文 空格-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}
async function fixture(t, options = {}) {
    const root = await temporary(t);
    const instances = [];
    class FixtureOJ {
        constructor(config) { this.config = config; instances.push(this); }
        async login() { return { user: this.config.credentials.username }; }
        listLanguages() { return [{ value: 4, label: 'C++17' }, { value: 7, label: 'Python3' }, { value: 9, label: 'JavaScript' }]; }
        async searchProblems() { return { problems: [{ id: 'P1001', title: '求和' }], hasMore: false }; }
        async getProblem(info) { return { ...info, content: { title: '求和', desc: '<p>计算和</p>', sampleInput: ['1 2\n'], sampleOutput: ['3\n'] } }; }
        async submit(source) {
            this.posts = (this.posts || 0) + 1;
            this.source = source;
            if (options.uploadFailure) { throw new Error('upload uncertain'); }
            if (options.delayUpload) { await new Promise(resolve => setTimeout(resolve, options.delayUpload)); }
            return Object.assign(async () => ({ result: options.pending ? 'Judging...' : 'Accepted', time: '1 ms', memory: '1 MB' }), { submissionId: '10001' });
        }
        resumeSubmission() { return async () => ({ result: 'Accepted' }); }
    }
    const vault = new MemoryVault();
    const serviceOptions = { vault, backends: { luogu: FixtureOJ }, ...options };
    const service = createService(serviceOptions);
    t.after(() => service.close());
    await service.dispatch('init', { root, backend: 'luogu' });
    await service.dispatch('login', { root, credentials: { username: 'student', password: 'secret-value' }, label: '测试账号' });
    const opened = await service.dispatch('account-open', { root, id: 'P1001', language: 'js' });
    const params = { root, kind: 'account', key: opened.problem.key, source: opened.source, language: 9 };
    return { root, service, serviceOptions, instances, vault, opened, params };
}

test('practice cache, all seven languages, reimport and custom tests interoperate', async t => {
    const root = await temporary(t);
    const service = createService();
    const call = (method, params = {}) => service.dispatch(method, { root, ...params });
    const file = path.join(root, '题目.json');
    await fs.writeFile(file, JSON.stringify({ name: 'A + B', url: 'https://www.luogu.com.cn/problem/P1001',
        statement: '求和', tests: [{ input: '1 2\n', output: '3\n' }] }));
    const [problem] = await call('practice-json', { file });
    assert.equal((await call('practice-list')).length, 1);
    assert.equal((await call('hello')).platforms.length, 9);
    for (const language of ['cpp', 'c', 'py', 'js', 'java', 'go', 'rs']) {
        const opened = await call('practice-open', { key: problem.key, language });
        assert.equal(path.extname(opened.source), '.' + language);
    }
    const opened = await call('practice-open', { key: problem.key, language: 'js' });
    await fs.writeFile(opened.source, 'process.stdin.resume(); let s=""; process.stdin.on("data",x=>s+=x); process.stdin.on("end",()=>console.log(s.trim().split(/\\s+/).map(Number).reduce((a,b)=>a+b,0)));');
    await call('tests-save', { key: problem.key, tests: [{ input: '-10 20\n', output: '10\n' }] });
    await call('practice-json', { file });
    assert.equal((await call('tests', { key: problem.key }))[0].input, '-10 20\n');
    assert.match(await fs.readFile(opened.source, 'utf8'), /process.stdin/);
    assert.equal((await call('source-info', { source: opened.source })).key, problem.key);
    const results = await call('run', { key: problem.key, source: opened.source });
    assert.equal(results[0].passed, true);
    assert.equal(results[0].expected, '10\n');
    await call('practice-remove', { key: problem.key });
    assert.equal((await call('practice-list')).length, 0);
    await call('practice-json', { file });
    assert.equal((await call('practice-list')).length, 1);
    await assert.rejects(call('practice-open', { key: '../../escape' }), /无效/);
    await assert.rejects(call('tests-save', { key: problem.key, tests: [null] }), /测试/);
    assert.equal((await call('tools', { language: 'js' }))[0].available, true);
});

test('runner distinguishes WA, RE, TLE, OLE and compile errors', async t => {
    const { root, service, params } = await fixture(t);
    const run = () => service.dispatch('run', { ...params, timeout: 150 });
    await fs.writeFile(params.source, 'console.log(4);');
    assert.equal((await run())[0].passed, false);
    await fs.writeFile(params.source, 'process.exit(2);');
    assert.equal((await run())[0].code, 2);
    await fs.writeFile(params.source, 'setInterval(()=>{},1000);');
    assert.equal((await run())[0].timedOut, true);
    await fs.writeFile(params.source, 'process.stdout.write("x".repeat(2*1024*1024));');
    assert.equal((await run())[0].overflow, true);
    const cpp = await service.dispatch('account-open', { root, id: 'P1001', language: 'cpp' });
    await fs.writeFile(cpp.source, 'invalid c++');
    await assert.rejects(service.dispatch('run', { ...params, source: cpp.source }), /编译失败/);
    await fs.writeFile(cpp.source, '#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b;}');
    assert.equal((await service.dispatch('run', { ...params, source: cpp.source }))[0].passed, true);
});

test('submission language, completion, source binding and secret-free files', async t => {
    const { root, service, params, instances } = await fixture(t);
    await assert.rejects(service.dispatch('submit', { ...params, language: 4 }), /语言/);
    const record = await service.dispatch('submit', params);
    assert.equal(record.state, 'completed');
    assert.equal(record.recordId, '10001');
    assert.equal(instances.at(-1).source.sourceType, 'js');
    assert.equal((await service.dispatch('account-list', { root })).problems[0].status, '✓ 已AC');
    assert.equal((await service.dispatch('source-info', { root, source: params.source })).kind, 'account');
    const config = await fs.readFile(path.join(root, '.oj-assistant/emacs.json'), 'utf8');
    const history = await fs.readFile(path.join(root, '.oj-assistant/emacs-history.json'), 'utf8');
    assert.ok(!config.includes('secret-value'));
    assert.ok(!history.includes('secret-value'));
});

test('paused submissions block duplicate upload and resume after service restart', async t => {
    const { root, service, serviceOptions, params, instances } = await fixture(t, { pending: true, pollTimeout: 30, pollInterval: 5 });
    const record = await service.dispatch('submit', params);
    assert.equal(record.state, 'paused');
    await assert.rejects(service.dispatch('submit', params), /未结束/);
    assert.equal(instances.at(-1).posts, 1);
    const fresh = createService(serviceOptions);
    const resumed = await fresh.dispatch('resume', { root, id: record.localId });
    assert.equal(resumed.state, 'completed');
    assert.equal(resumed.verdict.result, 'Accepted');
    assert.equal(instances.reduce((sum, instance) => sum + (instance.posts || 0), 0), 1);
});

test('stop waiting and resume reuse the existing submission', async t => {
    const { root, service, params, instances } = await fixture(t, { pending: true, pollInterval: 10 });
    const pending = service.dispatch('submit', params);
    let record;
    for (let i = 0; i < 100; i++) {
        [record] = await service.dispatch('history', { root });
        if (record?.state === 'waiting') { break; }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    await service.dispatch('pause', { root, id: record.localId });
    assert.equal((await pending).state, 'paused');
    assert.equal(instances.at(-1).posts, 1);
});

test('concurrent submits upload once and late upload IDs survive timeout', async t => {
    const { root, service, params, instances } = await fixture(t, { delayUpload: 80, uploadTimeout: 10 });
    const results = await Promise.allSettled([service.dispatch('submit', params), service.dispatch('submit', params)]);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const record = results.find(result => result.status === 'fulfilled').value;
    assert.equal(record.state, 'unknown');
    await assert.rejects(service.dispatch('submission-dismiss', { root, id: record.localId }), /仍在上传/);
    await new Promise(resolve => setTimeout(resolve, 130));
    const [saved] = await service.dispatch('history', { root });
    assert.equal(saved.recordId, '10001');
    assert.equal(saved.state, 'paused');
    assert.equal(instances.at(-1).posts, 1);
    const completed = await service.dispatch('resume', { root, id: record.localId });
    assert.equal(completed.state, 'completed');
});

test('uncertain upload can be acknowledged only explicitly', async t => {
    const { root, service, params } = await fixture(t, { uploadFailure: true });
    const record = await service.dispatch('submit', params);
    assert.equal(record.state, 'unknown');
    await assert.rejects(service.dispatch('submit', params), /未结束/);
    await service.dispatch('submission-dismiss', { root, id: record.localId });
    assert.equal((await service.dispatch('history', { root }))[0].state, 'failed');
});

test('saved accounts are reusable and a switched account cannot submit stale problem metadata', async t => {
    const { root, service, params } = await fixture(t);
    const second = await temporary(t);
    const [account] = await service.dispatch('accounts', { root });
    assert.ok(!('credentials' in account));
    await service.dispatch('account-use', { root: second, id: account.id });
    assert.equal((await service.dispatch('account-list', { root: second })).account, 'student');
    await service.dispatch('init', { root, backend: 'luogu', replace: true });
    await service.dispatch('login', { root, credentials: { username: 'another', password: 'other-secret' } });
    await assert.rejects(service.dispatch('submit', params), /不匹配/);
});

test('selected Emacs account never inherits a foreign VS Code endpoint or credentials', async t => {
    const { root, serviceOptions, instances } = await fixture(t);
    await fs.writeFile(path.join(root, '.ojassistconfig.json'), JSON.stringify({ backend: 'csecg',
        baseUrl: 'https://foreign.invalid', credentials: { username: 'foreign', password: 'foreign-secret' } }));
    const fresh = createService(serviceOptions);
    assert.equal((await fresh.dispatch('account-list', { root })).account, 'student');
    assert.equal(instances.at(-1).config.baseUrl, undefined);
    assert.equal(instances.at(-1).config.credentials.password, 'secret-value');
});

test('Windows DPAPI vault round-trips Unicode without plaintext on disk', { skip: process.platform !== 'win32' }, async t => {
    const directory = await temporary(t);
    const vault = new AccountVault(directory);
    const account = { id: 'test', backend: 'luogu', label: '测试账号', credentials: { cookies: 'cookie-secret-中文' } };
    await vault.save(account);
    const fresh = new AccountVault(directory);
    assert.deepEqual(await fresh.list(), [account]);
    const encrypted = await fs.readFile(path.join(directory, 'accounts.dpapi'), 'utf8');
    assert.ok(!encrypted.includes('cookie-secret'));
});

test('atomic JSON replacement retries sharing locks and preserves data on permanent failure', async t => {
    const root = await temporary(t);
    const file = path.join(root, 'history.json');
    const originalRename = fs.rename;
    await fs.writeFile(file, JSON.stringify({ value: 1 }));
    let attempts = 0;
    try {
        fs.rename = async (from, to) => {
            if (to === file && ++attempts < 3) { throw Object.assign(new Error('sharing lock'), { code: 'EPERM' }); }
            return originalRename(from, to);
        };
        await writeJson(file, { value: 2 });
        assert.equal(attempts, 3);
        assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { value: 2 });
        fs.rename = async (from, to) => {
            if (to === file) { throw Object.assign(new Error('invalid destination'), { code: 'EINVAL' }); }
            return originalRename(from, to);
        };
        await assert.rejects(writeJson(file, { value: 3 }), /invalid destination/);
        assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { value: 2 });
        assert.deepEqual(await fs.readdir(root), ['history.json']);
    } finally { fs.rename = originalRename; }
});
