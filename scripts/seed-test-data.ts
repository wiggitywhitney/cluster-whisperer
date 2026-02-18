/**
 * seed-test-data.ts - Loads test documents into the capabilities collection
 *
 * Populates Chroma with a small set of representative Kubernetes resource
 * descriptions for testing the agent's vector search tools. These are the
 * same 3 documents used in M2 testing.
 *
 * Usage:
 *   vals exec -i -f .vals.yaml -- npx tsx scripts/seed-test-data.ts
 */

import { ChromaBackend } from "../src/vectorstore/chroma-backend";
import { VoyageEmbedding } from "../src/vectorstore/embeddings";
import type { VectorDocument } from "../src/vectorstore/types";
import {
  CAPABILITIES_COLLECTION,
  INSTANCES_COLLECTION,
} from "../src/vectorstore";

const testDocuments: VectorDocument[] = [
  {
    id: "devopstoolkit.live/v1beta1/SQL",
    text: "SQL is a managed database solution provided by the devopstoolkit.live API group. It allows developers to provision and manage SQL databases (PostgreSQL, MySQL) through a simple Kubernetes-native interface. Handles backups, scaling, and connection pooling automatically.",
    metadata: {
      kind: "SQL",
      apiGroup: "devopstoolkit.live",
      isCRD: true,
    },
  },
  {
    id: "apps/v1/Deployment",
    text: "Deployment manages a set of identical pods, ensuring the desired number are running at all times. Supports rolling updates, rollbacks, and scaling. The standard way to run stateless applications on Kubernetes.",
    metadata: {
      kind: "Deployment",
      apiGroup: "apps",
      isCRD: false,
    },
  },
  {
    id: "networking.k8s.io/v1/Ingress",
    text: "Ingress exposes HTTP and HTTPS routes from outside the cluster to services within the cluster. Manages external access to services, typically HTTP. Provides load balancing, SSL termination, and name-based virtual hosting for network traffic routing.",
    metadata: {
      kind: "Ingress",
      apiGroup: "networking.k8s.io",
      isCRD: false,
    },
  },
];

async function main() {
  console.log("Initializing vector store...");
  const embedder = new VoyageEmbedding();
  const store = new ChromaBackend(embedder);

  // Initialize both collections
  await store.initialize(CAPABILITIES_COLLECTION, { distanceMetric: "cosine" });
  await store.initialize(INSTANCES_COLLECTION, { distanceMetric: "cosine" });
  console.log("Collections initialized.");

  // Store test documents in capabilities (single embed call for all 3)
  console.log(`Storing ${testDocuments.length} test documents...`);
  await store.store(CAPABILITIES_COLLECTION, testDocuments);
  console.log("Documents stored.");

  // Verify with a search
  console.log("\nVerification search: 'database'");
  const results = await store.search(CAPABILITIES_COLLECTION, "database", {
    nResults: 3,
  });
  for (const result of results) {
    console.log(`  ${result.id} (distance: ${result.score.toFixed(3)})`);
  }

  console.log("\nSeed complete.");
}

main().catch(console.error);
