import type { ReactNode } from 'react';
import { WingsLogo3D } from './WingsLogo3D.js';
import './login-shell.css';

/**
 * The login screen's frame: the logo in relief over noble black on the left,
 * the form in a light card on the right. It only lays out; the form and its
 * authentication are the page's own.
 */
export function LoginShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <main className="login-shell">
      <div className="login-shell__brand">
        <WingsLogo3D variant="dark" motion="full" fit={0.78} height={380} />
      </div>
      <section className="login-shell__card">
        <h1 className="login-shell__title">{title}</h1>
        {subtitle && <p className="login-shell__subtitle">{subtitle}</p>}
        {children}
      </section>
    </main>
  );
}
