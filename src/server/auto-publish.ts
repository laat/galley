// Auto-publish, after GitHub's auto-merge. The reviewer approves publishing in advance, and
// laatsux publishes on its own once the agents are done with the pull request: the reviewer
// agents with its head, and the author with their feedback (Service.readiness).
import type { PullRow } from './db.ts';
import { HttpError, publishFingerprint, type ChangeEvent, type Service } from './service.ts';

export class AutoPublisher {
  private s: Service;
  /** Checks running, per pull id; shutdown waits for them, since they may be publishing. */
  private running = new Map<number, Promise<void>>();
  /** Pull requests that changed while a check of them ran, to be checked again after it. */
  private again = new Set<number>();
  private stopped = false;
  private onChange = (e: ChangeEvent) => {
    if (e.pullId !== null) this.consider(e.pullId);
  };
  // An author that starts waiting again within seconds sends no change event (see Service.setWaiting).
  private onWaiting = (pullId: number) => this.consider(pullId);

  constructor(s: Service) {
    this.s = s;
  }

  start(): void {
    this.s.bus.on('change', this.onChange);
    this.s.bus.on('author-waiting', this.onWaiting);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.s.bus.off('change', this.onChange);
    this.s.bus.off('author-waiting', this.onWaiting);
    await Promise.allSettled([...this.running.values()]);
  }

  /**
   * Check every pull request that has auto-publish on. The server does this when it polls, for
   * what changes without an event: settings, or an automatic review that decided not to start.
   */
  considerAll(): void {
    // A poll that was under way when the server closed must not touch the closed database.
    if (this.stopped) return;
    for (const { id } of this.s.db.all<{ id: number }>("SELECT id FROM pulls WHERE auto_publish IS NOT NULL AND state != 'closed'")) this.consider(id);
  }

  /** Publish in the background if auto-publish is on and the agents are done. */
  consider(pullId: number): void {
    if (this.stopped) return;
    if (this.running.has(pullId)) {
      this.again.add(pullId);
      return;
    }
    const p = this.publishIfReady(pullId)
      .catch((e) => console.error('auto-publish:', e))
      .finally(() => {
        this.running.delete(pullId);
        if (this.again.delete(pullId)) this.consider(pullId);
      });
    this.running.set(pullId, p);
  }

  private async publishIfReady(pullId: number): Promise<void> {
    // Let whoever emitted the change finish first.
    await new Promise((resolve) => setImmediate(resolve));
    const known = this.s.db.get<PullRow>('SELECT * FROM pulls WHERE id = ?', pullId);
    // Most checks end here, without running git: the poll syncs pushes, and announces them.
    if (!known || !this.s.autoPublishReady(known)) return;
    const repo = this.s.repoById(known.repo_id);
    const ctx = await this.s.ctx(repo.owner, repo.name, known.number);
    const pull = ctx.pull;
    if (!this.s.autoPublishReady(pull)) return;
    // The attempt is bound to this exact approval: replaced or turned off, it stops.
    const approval = pull.auto_publish!;
    const auto = this.s.autoPublish(pull)!;
    const by = this.s.db.actorById(auto.by);
    try {
      // Exactly the head that was checked: a push since then fails the fingerprint and waits for the next round.
      // Force is allowed as approved; publish decides whether the push needs it.
      await this.s.publish(ctx, { sign: auto.sign, draft: auto.draft, force: auto.force, autoMerge: auto.autoMerge ?? undefined, expected: publishFingerprint(pull), approval }, by);
    } catch (e) {
      // Changed since the check (a push, an edit, new feedback, a review starting, a new approval): the change brings another check.
      if (e instanceof HttpError && (e.status === 412 || e.status === 428)) return;
      this.s.autoPublishFailed(pull, by, (e as Error).message, approval);
    }
  }
}
