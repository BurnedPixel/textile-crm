// client:only="react" — auth.login is browser-only (cookie session against /db/_session).
import { useState, useRef, type FormEvent } from 'react';
import { Button, Field, Input } from '../ui';

export default function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = nameRef.current?.value.trim() ?? '';
    const password = passRef.current?.value ?? '';
    if (!name || !password) {
      setError('Completa usuario y contraseña.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const { login } = await import('../../lib/auth');
      await login(name, password);
      location.replace('/');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg || 'Credenciales incorrectas. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}
    >
      <Field label="Usuario" error={undefined}>
        <Input
          ref={nameRef}
          name="username"
          autoComplete="username"
          autoFocus
          disabled={loading}
          placeholder="nombre de usuario"
        />
      </Field>

      <Field label="Contraseña" error={error ?? undefined}>
        <Input
          ref={passRef}
          name="password"
          type="password"
          autoComplete="current-password"
          disabled={loading}
          placeholder="••••••••"
        />
      </Field>

      <Button
        type="submit"
        disabled={loading}
        size="lg"
        style={{ marginTop: '4px' }}
      >
        {loading ? 'Entrando…' : 'Entrar'}
      </Button>
    </form>
  );
}
