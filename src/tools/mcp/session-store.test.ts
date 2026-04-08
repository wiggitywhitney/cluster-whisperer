// ABOUTME: Unit tests for SessionStore — in-memory store for kubectl_apply_dryrun session state
// ABOUTME: Tests session creation, consumption, replacement, and stale session handling

import { describe, it, expect, beforeEach } from "vitest";
import { SessionStore } from "./session-store";

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
  });

  describe("store()", () => {
    it("stores a manifest and returns a session ID", () => {
      const sessionId = store.store("apiVersion: v1\nkind: Pod");
      expect(typeof sessionId).toBe("string");
      expect(sessionId.length).toBeGreaterThan(0);
    });

    it("returns a unique session ID each call", () => {
      const id1 = store.store("manifest-1");
      const id2 = store.store("manifest-2");
      expect(id1).not.toBe(id2);
    });

    it("invalidates the previous session ID when a new session is stored", () => {
      const oldId = store.store("old manifest");
      store.store("new manifest"); // replaces previous session
      const result = store.consume(oldId);
      expect(result).toBeUndefined();
    });
  });

  describe("consume()", () => {
    it("returns the manifest for a valid session ID", () => {
      const manifest = "apiVersion: platform.acme.io/v1\nkind: ManagedService";
      const sessionId = store.store(manifest);
      const result = store.consume(sessionId);
      expect(result).toBe(manifest);
    });

    it("returns undefined for an unknown session ID", () => {
      const result = store.consume("not-a-real-session-id");
      expect(result).toBeUndefined();
    });

    it("returns undefined for an already-consumed session ID (single-use)", () => {
      const manifest = "apiVersion: platform.acme.io/v1\nkind: ManagedService";
      const sessionId = store.store(manifest);
      store.consume(sessionId); // first consume
      const second = store.consume(sessionId); // second consume
      expect(second).toBeUndefined();
    });

    it("returns undefined for a session ID from a replaced session", () => {
      const oldId = store.store("old manifest");
      store.store("new manifest");
      expect(store.consume(oldId)).toBeUndefined();
    });
  });

  describe("peek()", () => {
    it("returns the manifest without consuming the session", () => {
      const manifest = "apiVersion: platform.acme.io/v1\nkind: ManagedService";
      const sessionId = store.store(manifest);
      store.peek(sessionId);
      // session should still be available
      expect(store.consume(sessionId)).toBe(manifest);
    });

    it("returns undefined for an unknown session ID", () => {
      expect(store.peek("unknown-id")).toBeUndefined();
    });
  });
});
