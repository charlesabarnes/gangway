/** What the operator stopped, kept in memory so serving asks without a query; read back at boot. */
export class Blocks {
  readonly #orgs = new Set<string>();
  readonly #suspended = new Map<string, string>();
  readonly #takenDown = new Set<string>();
  readonly #hosts = new Set<string>();

  suspended(orgId: string): boolean {
    return this.#orgs.has(orgId);
  }

  suspend(orgId: string, previewIds: Iterable<string>): void {
    this.#orgs.add(orgId);
    for (const id of previewIds) {
      this.#suspended.set(id, orgId);
    }
  }

  resume(orgId: string): void {
    this.#orgs.delete(orgId);
    for (const [id, org] of this.#suspended) {
      if (org === orgId) {
        this.#suspended.delete(id);
      }
    }
  }

  takeDown(previewId: string, hostnames: Iterable<string>): void {
    this.#takenDown.add(previewId);
    for (const h of hostnames) {
      this.#hosts.add(h);
    }
  }

  lift(hostname: string, previewDown: boolean, previewId: string): void {
    this.#hosts.delete(hostname);
    if (!previewDown) {
      this.#takenDown.delete(previewId);
    }
  }

  gone(host: string, previewId?: string): boolean {
    if (this.#hosts.has(host)) {
      return true;
    }
    return (
      previewId !== undefined && (this.#suspended.has(previewId) || this.#takenDown.has(previewId))
    );
  }
}
