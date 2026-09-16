import { Link } from 'react-router-dom';
import { AuthCard } from '../components/ui.js';

export function NotFoundPage() {
  return (
    <AuthCard title="Página não encontrada">
      <p className="auth-subtitle">O endereço acessado não existe no Wings System.</p>
      <p className="auth-footer">
        <Link to="/">Voltar ao início</Link>
      </p>
    </AuthCard>
  );
}
