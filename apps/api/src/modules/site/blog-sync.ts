import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { siteBlogPosts, WINGS_TENANT_ID } from '../../db/schema/index.js';
import type { WordPressClient } from '../../lib/wordpress.js';
import type { BlogPostSummary } from '@wings/shared';

/**
 * The mirror of Wings' blog, kept by the ingest job.
 *
 * Reads the site's published posts and their categories, and upserts them
 * here so the dashboard never has to call the site. The newest pull wins. It
 * never writes to the site: `listPublishedPosts` and `listCategories` are
 * the only calls made.
 */

export interface BlogSyncResult {
  posts: number;
}

export async function syncBlogPosts(
  db: Database,
  client: WordPressClient,
  now = new Date(),
): Promise<BlogSyncResult> {
  const [posts, categories] = await Promise.all([
    client.listPublishedPosts(),
    client.listCategories(),
  ]);
  const nameOf = new Map(categories.map((term) => [term.id, term.name]));

  for (const post of posts) {
    const figures = {
      title: post.title,
      slug: post.slug,
      link: post.link,
      publishedAt: new Date(post.publishedAt),
      modifiedAt: post.modifiedAt ? new Date(post.modifiedAt) : null,
      categories: post.categoryIds.map((id) => ({ id, name: nameOf.get(id) ?? String(id) })),
      fetchedAt: now,
    };
    await db
      .insert(siteBlogPosts)
      .values({ tenantId: WINGS_TENANT_ID, wordpressPostId: post.id, ...figures })
      .onConflictDoUpdate({
        target: [siteBlogPosts.tenantId, siteBlogPosts.wordpressPostId],
        set: figures,
      });
  }
  return { posts: posts.length };
}

/** Posts published between two instants, newest first, from the mirror. */
export async function mirroredPosts(
  db: Database,
  since: Date,
  until: Date,
): Promise<{ posts: BlogPostSummary[]; syncedAt: string | null; mirrored: number }> {
  const [rows, [meta]] = await Promise.all([
    db
      .select()
      .from(siteBlogPosts)
      .where(and(gte(siteBlogPosts.publishedAt, since), lte(siteBlogPosts.publishedAt, until)))
      .orderBy(desc(siteBlogPosts.publishedAt))
      .limit(500),
    db
      .select({
        syncedAt: sql<Date | null>`max(${siteBlogPosts.fetchedAt})`,
        mirrored: sql<string>`count(*)`,
      })
      .from(siteBlogPosts)
      .where(eq(siteBlogPosts.tenantId, WINGS_TENANT_ID)),
  ]);
  return {
    posts: rows.map((row) => ({
      id: row.wordpressPostId,
      title: row.title,
      publishedAt: row.publishedAt.toISOString(),
      modifiedAt: row.modifiedAt?.toISOString() ?? null,
      categories: ((row.categories as { name: string }[]) ?? []).map((item) => item.name),
      link: row.link,
    })),
    syncedAt: meta?.syncedAt ? new Date(meta.syncedAt).toISOString() : null,
    mirrored: Number(meta?.mirrored ?? 0),
  };
}
