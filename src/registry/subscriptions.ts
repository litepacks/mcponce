/**
 * Manages active resource URI subscriptions across MCP client sessions.
 */
export class SubscriptionRegistry {
  // Map of sessionId -> Set of subscribed URIs
  private sessionSubscriptions = new Map<string, Set<string>>();
  // Map of URI -> Set of subscribed sessionIds
  private uriSubscribers = new Map<string, Set<string>>();

  /**
   * Subscribes a session to a specific resource URI.
   */
  subscribe(sessionId: string, uri: string): void {
    if (!sessionId || !uri) return;

    let uris = this.sessionSubscriptions.get(sessionId);
    if (!uris) {
      uris = new Set();
      this.sessionSubscriptions.set(sessionId, uris);
    }
    uris.add(uri);

    let sessions = this.uriSubscribers.get(uri);
    if (!sessions) {
      sessions = new Set();
      this.uriSubscribers.set(uri, sessions);
    }
    sessions.add(sessionId);
  }

  /**
   * Unsubscribes a session from a specific resource URI.
   */
  unsubscribe(sessionId: string, uri: string): void {
    this.sessionSubscriptions.get(sessionId)?.delete(uri);
    this.uriSubscribers.get(uri)?.delete(sessionId);

    if (this.uriSubscribers.get(uri)?.size === 0) {
      this.uriSubscribers.delete(uri);
    }
  }

  /**
   * Returns all session IDs that have subscribed to the given resource URI.
   */
  getSubscribers(uri: string): string[] {
    const sessions = this.uriSubscribers.get(uri);
    return sessions ? Array.from(sessions) : [];
  }

  /**
   * Checks if a session is subscribed to a specific resource URI.
   */
  isSubscribed(sessionId: string, uri: string): boolean {
    return this.sessionSubscriptions.get(sessionId)?.has(uri) ?? false;
  }

  /**
   * Returns all resource URIs subscribed to by a specific session.
   */
  getSubscriptions(sessionId: string): string[] {
    const uris = this.sessionSubscriptions.get(sessionId);
    return uris ? Array.from(uris) : [];
  }

  /**
   * Returns a list of all distinct resource URIs currently subscribed to across all sessions.
   */
  getAllSubscribedUris(): string[] {
    return Array.from(this.uriSubscribers.keys());
  }

  /**
   * Total number of unique resource URIs currently subscribed to.
   */
  get activeSubscriptionCount(): number {
    return this.uriSubscribers.size;
  }

  /**
   * Removes all subscriptions associated with a disconnected session.
   */
  removeSession(sessionId: string): void {
    const uris = this.sessionSubscriptions.get(sessionId);
    if (uris) {
      for (const uri of uris) {
        const set = this.uriSubscribers.get(uri);
        if (set) {
          set.delete(sessionId);
          if (set.size === 0) {
            this.uriSubscribers.delete(uri);
          }
        }
      }
      this.sessionSubscriptions.delete(sessionId);
    }
  }

  /**
   * Clears all subscriptions.
   */
  clear(): void {
    this.sessionSubscriptions.clear();
    this.uriSubscribers.clear();
  }
}
