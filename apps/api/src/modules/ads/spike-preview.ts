import { existsSync, readFileSync } from 'node:fs';

/**
 * Preview spike — does Meta's ad-preview API work for this account, with the
 * token we already have?
 *
 * The studio draws its own approximate preview because this was never
 * validated. Before building the real one, three things need an answer from
 * the live API rather than from the documentation:
 *
 *   1. does `generatepreviews` accept an inline creative spec, so that no
 *      creative object has to be created first?
 *   2. does it accept an image by public URL (`picture`), so that no image has
 *      to be uploaded to Meta — which would be a write?
 *   3. does the READ token suffice, or does it demand `ads_management`?
 *
 * Read-only: every call is a GET. Nothing is created, changed or spent.
 *
 * Run by a person who holds the token:
 *   pnpm --filter @wings/api exec tsx src/modules/ads/spike-preview.ts \
 *     <facebook-page-id> <public-https-image-url>
 */

function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed
      .slice(0, eq)
      .replace(/^export\s+/, '')
      .trim();
    out[key] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const secrets = readEnvFile('/etc/wings-crm/meta.env');
const TOKEN = secrets.META_SYSTEM_USER_TOKEN ?? '';
const ACCOUNT = secrets.META_AD_ACCOUNT_ID ?? '';
const VERSION = 'v23.0';
const [PAGE_ID, IMAGE_URL] = process.argv.slice(2);

if (!TOKEN || !ACCOUNT) throw new Error('read credentials missing');
if (!PAGE_ID || !IMAGE_URL?.startsWith('https://')) {
  throw new Error('usage: spike-preview.ts <facebook-page-id> <public-https-image-url>');
}

const FORMATS = ['MOBILE_FEED_STANDARD', 'INSTAGRAM_STANDARD', 'INSTAGRAM_STORY'];

async function main() {
  console.warn(`account: ${ACCOUNT}\n`);

  const creative = JSON.stringify({
    object_story_spec: {
      page_id: PAGE_ID,
      link_data: {
        link: 'https://wingscompany.com.br/',
        message: 'Spike de prévia — texto de teste.',
        name: 'Spike de prévia',
        picture: IMAGE_URL,
        call_to_action: { type: 'LEARN_MORE' },
      },
    },
  });

  for (const format of FORMATS) {
    const url = new URL(`https://graph.facebook.com/${VERSION}/${ACCOUNT}/generatepreviews`);
    url.searchParams.set('creative', creative);
    url.searchParams.set('ad_format', format);

    const response = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = (await response.json()) as {
      data?: { body?: string }[];
      error?: { code?: number; error_subcode?: number; message?: string };
    };

    if (!response.ok) {
      console.warn(
        `[${format}] ✗ error ${body.error?.code ?? response.status}` +
          `/${body.error?.error_subcode ?? '-'}: ${body.error?.message ?? 'unknown'}`,
      );
      continue;
    }
    const html = body.data?.[0]?.body ?? '';
    // The preview is an <iframe>; what matters for the studio is its src.
    const src = /src="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&') ?? null;
    console.warn(`[${format}] ✓ ${html.length} chars of HTML, iframe src: ${src ? 'yes' : 'NO'}`);
  }

  console.warn(
    '\nRecord the result in docs/ads/criar-campanha.md: which formats answered, and the error ' +
      'code of any that did not (#10 or #200 means the read token is not enough).',
  );
}

await main();
