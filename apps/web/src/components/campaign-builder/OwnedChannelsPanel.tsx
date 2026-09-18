/**
 * The owned-channels tab: places Wings publishes to without buying media.
 *
 * Deliberately not the paid-media form with fields hidden — the two share
 * nothing: there is no budget, no objective and no approval gate for a post on
 * our own site.
 */

const CHANNELS = [
  {
    key: 'wordpress',
    name: 'Site da Wings (WordPress)',
    description: 'Publicação de páginas e posts pela API REST do WordPress.',
    status: 'Em construção — etapa 5 desta onda',
    soon: false,
  },
  {
    key: 'portal',
    name: 'Portal ClickFranquia',
    description: 'Vitrine de franquias.',
    status: 'Em breve',
    soon: true,
  },
  {
    key: 'app',
    name: 'App ClickFranquia',
    description: 'Notificações e destaques no aplicativo.',
    status: 'Em breve',
    soon: true,
  },
] as const;

export function OwnedChannelsPanel() {
  return (
    <div className="builder">
      {CHANNELS.map((channel) => (
        <section
          key={channel.key}
          className={`builder-section ${channel.soon ? 'builder-section-soon' : ''}`}
          aria-label={channel.name}
        >
          <h2>
            {channel.name}
            <span className="tag coming-soon-tag">{channel.status}</span>
          </h2>
          <p className="muted">{channel.description}</p>
        </section>
      ))}
    </div>
  );
}
