import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const save = mutation({
  args: {
    findingId: v.string(),
    automationId: v.string(),
    conversationId: v.optional(v.string()),
    url: v.string(),
    contentHash: v.string(),
    title: v.string(),
    data: v.string(),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    // Check for duplicate by URL
    const byUrl = await ctx.db
      .query("researchFindings")
      .withIndex("by_url", (q) => q.eq("url", args.url))
      .first();
    if (byUrl) return { saved: false, reason: "duplicate_url", existingId: byUrl.findingId };

    // Check for duplicate by content hash
    const byHash = await ctx.db
      .query("researchFindings")
      .withIndex("by_content_hash", (q) => q.eq("contentHash", args.contentHash))
      .first();
    if (byHash) return { saved: false, reason: "duplicate_content", existingId: byHash.findingId };

    await ctx.db.insert("researchFindings", {
      ...args,
      status: "new",
      foundAt: Date.now(),
    });
    return { saved: true, findingId: args.findingId };
  },
});

export const checkUrls = query({
  args: { urls: v.array(v.string()) },
  handler: async (ctx, args) => {
    const known: { findingId: string; url: string; title: string; foundAt: number }[] = [];
    for (const url of args.urls) {
      const match = await ctx.db
        .query("researchFindings")
        .withIndex("by_url", (q) => q.eq("url", url))
        .first();
      if (match) {
        known.push({
          findingId: match.findingId,
          url: match.url,
          title: match.title,
          foundAt: match.foundAt,
        });
      }
    }
    return { known };
  },
});

export const checkHash = query({
  args: { contentHash: v.string() },
  handler: async (ctx, args) => {
    const match = await ctx.db
      .query("researchFindings")
      .withIndex("by_content_hash", (q) => q.eq("contentHash", args.contentHash))
      .first();
    if (!match) return { found: false };
    return {
      found: true,
      findingId: match.findingId,
      url: match.url,
      title: match.title,
    };
  },
});

export const markReported = mutation({
  args: { findingId: v.string() },
  handler: async (ctx, args) => {
    const finding = await ctx.db
      .query("researchFindings")
      .withIndex("by_finding_id", (q) => q.eq("findingId", args.findingId))
      .unique();
    if (!finding) return null;
    await ctx.db.patch(finding._id, { status: "reported", reportedAt: Date.now() });
    return finding._id;
  },
});

export const archive = mutation({
  args: { findingId: v.string() },
  handler: async (ctx, args) => {
    const finding = await ctx.db
      .query("researchFindings")
      .withIndex("by_finding_id", (q) => q.eq("findingId", args.findingId))
      .unique();
    if (!finding) return null;
    await ctx.db.patch(finding._id, { status: "archived" });
    return finding._id;
  },
});

export const listByAutomation = query({
  args: {
    automationId: v.string(),
    status: v.optional(v.union(v.literal("new"), v.literal("reported"), v.literal("archived"))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let q;
    if (args.status) {
      q = ctx.db
        .query("researchFindings")
        .withIndex("by_status", (qb) =>
          qb.eq("automationId", args.automationId).eq("status", args.status!),
        );
    } else {
      q = ctx.db
        .query("researchFindings")
        .withIndex("by_automation", (qb) => qb.eq("automationId", args.automationId));
    }
    const results = await q.order("desc").take(args.limit ?? 50);
    return results;
  },
});
