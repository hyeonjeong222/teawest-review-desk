// Runs on the same queue as review reads and publishing. It never calls publish.
export class AutoLogin {
  constructor(connector, vault, queue) { this.connector = connector; this.vault = vault; this.queue = queue; this.phase = 'idle'; this.pending = null; this.lastAttempt = 0; }
  publicState() { return { ...this.vault.publicState(), phase: this.phase }; }
  schedule() {
    if (this.pending || !this.vault.publicState().enabled) return this.pending || Promise.resolve();
    this.pending = this.queue.run(() => this.check()).catch(async () => {
      this.phase = 'needs_attention'; await this.vault.block('connection_error').catch(() => {});
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
  async check() {
    const config = this.vault.publicState();
    if (!config.enabled) { this.phase = 'disabled'; return; }
    const status = await this.connector.status();
    if (status.connected) { this.phase = 'connected'; if (config.blocked) await this.vault.block(null); return; }
    if (status.networkError) { this.phase = 'offline'; return; }
    if (config.blocked) { this.phase = config.blocked === 'verification' ? 'needs_verification' : 'needs_attention'; return; }
    // Limit retries even if an external session keeps expiring immediately.
    if (Date.now() - this.lastAttempt < 300000) { this.phase = 'cooldown'; return; }
    this.phase = 'reconnecting'; this.lastAttempt = Date.now();
    // Persist before any attempt, so a restart never repeats an uncertain login.
    await this.vault.block('interrupted');
    let credentials;
    try {
      credentials = await this.vault.credentials();
      const result = await this.connector.login(credentials);
      if (result.connected) { this.phase = 'connected'; await this.vault.block(null); }
      else { const reason = result.reason || 'verification'; this.phase = reason === 'verification' ? 'needs_verification' : 'needs_attention'; await this.vault.block(reason); }
    } catch (e) { this.phase = 'needs_attention'; await this.vault.block(e.code === 'VAULT_UNAVAILABLE' ? 'storage_error' : 'connection_error'); }
    finally { credentials = null; }
  }
  async save(data) { return this.queue.run(async () => { await this.vault.save(data); this.phase = data.enabled ? 'idle' : 'disabled'; this.lastAttempt = 0; return this.publicState(); }); }
  async forget() { return this.queue.run(async () => { await this.vault.forget(); this.phase = 'disabled'; return this.publicState(); }); }
}
