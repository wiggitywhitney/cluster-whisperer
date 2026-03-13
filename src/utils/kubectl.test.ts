// ABOUTME: Unit tests for kubectl utility — verifies sensitive arg redaction
// ABOUTME: and metadata extraction from kubectl command arguments.

import { describe, it, expect } from "vitest";
import { redactSensitiveArgs } from "./kubectl";

describe("redactSensitiveArgs", () => {
  it("passes through non-sensitive args unchanged", () => {
    const args = ["get", "pods", "-n", "default"];
    expect(redactSensitiveArgs(args)).toEqual(["get", "pods", "-n", "default"]);
  });

  it("redacts --flag value format (two separate args)", () => {
    const args = ["get", "pods", "--token", "secret123"];
    expect(redactSensitiveArgs(args)).toEqual([
      "get",
      "pods",
      "--token",
      "[REDACTED]",
    ]);
  });

  it("redacts --flag=value format without leaking original", () => {
    const args = ["get", "pods", "--token=secret123"];
    expect(redactSensitiveArgs(args)).toEqual([
      "get",
      "pods",
      "--token=[REDACTED]",
    ]);
  });

  it("redacts multiple sensitive flags in mixed formats", () => {
    const args = [
      "get",
      "pods",
      "--token=secret123",
      "--password",
      "pass456",
    ];
    expect(redactSensitiveArgs(args)).toEqual([
      "get",
      "pods",
      "--token=[REDACTED]",
      "--password",
      "[REDACTED]",
    ]);
  });

  it("redacts all known sensitive flags", () => {
    const flags = [
      "--token",
      "--password",
      "--client-key",
      "--client-certificate",
      "--kubeconfig",
    ];
    for (const flag of flags) {
      const args = ["get", "pods", `${flag}=secretvalue`];
      const result = redactSensitiveArgs(args);
      expect(result).toEqual(["get", "pods", `${flag}=[REDACTED]`]);
    }
  });

  it("does not redact flags that only start with a sensitive prefix", () => {
    const args = ["get", "pods", "--tokenizer=something"];
    expect(redactSensitiveArgs(args)).toEqual([
      "get",
      "pods",
      "--tokenizer=something",
    ]);
  });
});
