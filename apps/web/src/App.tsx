import { APP_NAME } from '@wings/shared';

/**
 * Phase 1 placeholder shell. The Cadastro de Funcionários screens and the
 * real navigation arrive after the RBAC model (Phase 2) is in place.
 */
export function App() {
  return (
    <main style={{ padding: '48px 24px', maxWidth: 720, margin: '0 auto' }}>
      <h1 style={{ fontSize: 24, fontWeight: 600 }}>{APP_NAME}</h1>
      <p style={{ color: 'var(--wings-muted)', marginTop: 8, fontSize: 14 }}>
        Ambiente configurado. Módulo de Cadastro de Funcionários em construção.
      </p>
    </main>
  );
}
