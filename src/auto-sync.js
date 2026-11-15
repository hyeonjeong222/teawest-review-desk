import { AppError, SerialQueue } from './core.js';

const loginCodes = new Set(['LOGIN_REQUIRED', 'COUPANG_LOGIN_REQUIRED', 'ABLY_LOGIN_REQUIRED', 'DELIVERY_LOGIN_REQUIRED', 'BROWSER_REQUIRED']);
export class AutoReviewSync {
  constructor(store, sources, { now = Date.now } = {}) {
    this.store = store; this.sources = sources; this.now = now; this.pending = new Map(); this.settingsQueue = new SerialQueue(); this.stopped = false;
    this.platforms = Object.keys(sources);
    this.jobs = Object.fromEntries(this.platforms.map(platform => [platform, { phase: 'waiting', nextRunAt: now(), lastSuccessAt: this.metadata(platform)?.lastSync || null, observedSync: this.metadata(platform)?.lastSync || null, lastAttemptAt: null, failures: 0, error: null, added: 0 }]));
  }
  metadata(platform) { return this.store.data.syncs?.[platform] || (platform === 'naver' ? this.store.data.sync : null); }
  config() { const saved = this.store.data.autoSync; return { enabled: saved?.enabled !== false, intervalMinutes: [5, 10, 30, 60].includes(saved?.intervalMinutes) ? saved.intervalMinutes : 10 }; }
  publicState() {
    const config = this.config();
    return { ...config, platforms: Object.fromEntries(this.platforms.map(platform => {
      const { observedSync, failures, ...job } = this.jobs[platform];
      return [platform, { ...job, nextRunAt: config.enabled && !this.stopped && job.nextRunAt ? new Date(job.nextRunAt).toISOString() : null, period: this.metadata(platform)?.period || '3m' }];
    })) };
  }
  async save(data) {
    if (typeof data?.enabled !== 'boolean' || ![5, 10, 30, 60].includes(data.intervalMinutes)) throw new AppError('자동 가져오기 사용 여부와 주기를 확인해 주세요.');
    return this.settingsQueue.run(async () => {
      const previous = this.config();
      await this.store.update(s => { s.autoSync = { enabled: data.enabled, intervalMinutes: data.intervalMinutes }; });
      for (const platform of this.platforms) {
        const job = this.jobs[platform];
        if (data.enabled && !previous.enabled) job.nextRunAt = this.now();
        else if (data.enabled && previous.intervalMinutes !== data.intervalMinutes) job.nextRunAt = Math.max(this.now(), (Date.parse(job.lastSuccessAt) || this.now()) + data.intervalMinutes * 60000);
      }
      if (data.enabled) void this.tick();
      return this.publicState();
    });
  }
  tick() {
    if (this.stopped || !this.config().enabled) return Promise.resolve([]);
    for (const platform of this.platforms) {
      if (this.pending.has(platform)) continue;
      const job = this.jobs[platform], synced = this.metadata(platform)?.lastSync;
      if (synced && synced !== job.observedSync) {
        job.observedSync = synced; job.lastSuccessAt = synced; job.error = null; job.failures = 0; job.phase = 'waiting';
        job.nextRunAt = Date.parse(synced) + this.config().intervalMinutes * 60000;
      }
      if (this.now() < job.nextRunAt) continue;
      // Set pending before yielding: any number of browser tabs or timer ticks produces one job.
      const task = this.run(platform).finally(() => this.pending.delete(platform));
      this.pending.set(platform, task);
    }
    return Promise.allSettled([...this.pending.values()]);
  }
  async run(platform) {
    const source = this.sources[platform], job = this.jobs[platform];
    job.phase = 'checking'; job.lastAttemptAt = new Date(this.now()).toISOString(); job.error = null; job.nextRunAt = null;
    try {
      await source.autoLogin?.schedule();
      if (this.stopped || !this.config().enabled) { job.phase = 'waiting'; job.nextRunAt = this.now(); return; }
      const status = await source.connector.status();
      if (!status.connected) {
        job.phase = status.networkError ? 'offline' : 'login_required';
        job.error = status.networkError ? '인터넷 연결을 확인해 주세요. 저장된 리뷰는 유지됩니다.' : '로그인 또는 추가 인증을 완료하면 자동으로 다시 가져옵니다.';
        job.nextRunAt = this.now() + 60000; return;
      }
      const ids = new Set(this.store.data.reviews.filter(r => (r.platform || 'naver') === platform).map(r => r.id));
      job.phase = 'syncing';
      await source.service.sync(undefined, { automatic: true, shouldRun: () => !this.stopped && this.config().enabled });
      job.added = this.store.data.reviews.filter(r => (r.platform || 'naver') === platform && !ids.has(r.id)).length;
      job.lastSuccessAt = this.metadata(platform)?.lastSync || new Date(this.now()).toISOString(); job.observedSync = this.metadata(platform)?.lastSync;
      job.phase = 'waiting'; job.failures = 0; job.error = null; job.nextRunAt = this.now() + this.config().intervalMinutes * 60000;
    } catch (error) {
      if (error.code === 'AUTO_SYNC_CANCELLED') { job.phase = 'waiting'; job.error = null; job.nextRunAt = this.now(); return; }
      job.phase = loginCodes.has(error.code) ? 'login_required' : 'error'; job.failures++;
      job.error = error instanceof AppError ? error.message : '리뷰를 가져오지 못했습니다. 기존 목록은 유지하며 잠시 후 다시 확인합니다.';
      job.nextRunAt = this.now() + (job.phase === 'login_required' ? 60000 : Math.min(60, this.config().intervalMinutes * 2 ** Math.min(job.failures - 1, 3)) * 60000);
    }
  }
  stop() { this.stopped = true; }
}
