import { describe, expect, it } from 'vitest';
import { emailAttachmentRefusal, leadEmailComposeSchema } from './crm-automations.js';

describe('emailAttachmentRefusal', () => {
  it('lets documents and pictures through', () => {
    expect(emailAttachmentRefusal('proposta.pdf', 'application/pdf')).toBeNull();
    expect(emailAttachmentRefusal('Fachada.JPG', 'image/jpeg')).toBeNull();
    expect(emailAttachmentRefusal('planilha.xlsx', null)).toBeNull();
    expect(emailAttachmentRefusal('sem-extensao', 'application/octet-stream')).toBeNull();
  });

  it('refuses programs and scripts by extension, whatever the type says', () => {
    for (const name of ['setup.exe', 'RUN.BAT', 'macro.vbs', 'install.sh', 'app.js', 'x.ps1'])
      expect(emailAttachmentRefusal(name, 'application/octet-stream')).toMatch(/Programas/);
  });

  it('refuses programs and scripts by type, whatever the name says', () => {
    expect(emailAttachmentRefusal('foto.jpg', 'application/x-msdownload')).toMatch(/Programas/);
    expect(emailAttachmentRefusal('nota.txt', 'text/javascript')).toMatch(/Programas/);
  });
});

describe('leadEmailComposeSchema', () => {
  it('needs an address, a subject and a text; attachments are optional', () => {
    const ok = leadEmailComposeSchema.parse({ to: 'a@b.com', subject: ' Oi ', text: 'Texto' });
    expect(ok).toEqual({
      to: 'a@b.com',
      subject: 'Oi',
      text: 'Texto',
      templateId: null,
      fileIds: [],
    });
    expect(leadEmailComposeSchema.safeParse({ to: 'x', subject: 'a', text: 'b' }).success).toBe(
      false,
    );
    expect(
      leadEmailComposeSchema.safeParse({ to: 'a@b.com', subject: ' ', text: 'b' }).success,
    ).toBe(false);
  });
});
