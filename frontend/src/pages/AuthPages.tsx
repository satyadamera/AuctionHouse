import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@/context/AuthContext';
import { ApiError, errorMessage } from '@/services/api';
import { Field, Input, PasswordInput } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';
import { Wordmark } from '@/components/Wordmark';

const loginSchema = z.object({ email: z.string().trim().email('Enter a valid email address'), password: z.string().min(1, 'Enter your password') });
const registerSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name'),
  email: z.string().trim().email('Enter a valid email address'),
  password: z.string().min(8, 'Use at least 8 characters').regex(/[A-Za-z]/, 'Include a letter').regex(/\d/, 'Include a number'),
  role: z.enum(['USER', 'SELLER']),
});

function AuthShell({ title, subtitle, children }: { title: string; subtitle: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex max-w-md flex-col px-4 py-16">
      <Wordmark />
      <h1 className="mt-8 text-4xl">{title}</h1>
      <p className="mt-2 text-ink-soft">{subtitle}</p>
      <div className="mt-8">{children}</div>
    </div>
  );
}

const DEMO = import.meta.env.DEV
  ? ['aarav@auctra.dev', 'diya@auctra.dev', 'meera@auctra.dev', 'admin@auctra.dev']
  : [];

export function LoginPage() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setValue, formState } = useForm<z.infer<typeof loginSchema>>({ resolver: zodResolver(loginSchema) });

  if (user) return <Navigate to={from} replace />;
  const onSubmit = handleSubmit(async (v) => {
    setFormError(null);
    try {
      await login(v.email, v.password);
      navigate(from, { replace: true });
    } catch (err) {
      setFormError(err instanceof ApiError && err.code === 'INVALID_CREDENTIALS' ? 'That email and password don’t match an account.' : errorMessage(err));
    }
  });

  return (
    <AuthShell title="Sign in" subtitle={<>New here? <Link to="/register" state={location.state} className="font-medium text-baize underline underline-offset-4">Create an account</Link></>}>
      <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
        {formError && <p role="alert" className="rounded-md bg-outbid-tint px-3 py-2 text-sm text-outbid">{formError}</p>}
        <Field label="Email" error={formState.errors.email?.message}>
          {({ id, describedBy }) => <Input id={id} type="email" autoComplete="email" aria-describedby={describedBy} aria-invalid={Boolean(formState.errors.email)} {...register('email')} />}
        </Field>
        <Field label="Password" error={formState.errors.password?.message}>
          {({ id, describedBy }) => <PasswordInput id={id} autoComplete="current-password" aria-describedby={describedBy} aria-invalid={Boolean(formState.errors.password)} {...register('password')} />}
        </Field>
        <Button type="submit" size="lg" loading={formState.isSubmitting}>Sign in</Button>
      </form>
      {DEMO.length > 0 && (
        <div className="mt-10 rounded-lg border border-dashed border-line-strong p-4 text-sm">
          <p className="font-medium">Demo accounts (development only)</p>
          <p className="mt-1 text-muted">Password for all: <code className="rounded bg-ink/5 px-1">Auctra@2026</code></p>
          <div className="mt-3 flex flex-wrap gap-2">
            {DEMO.map((email) => (
              <button key={email} type="button" className="rounded-sm border border-line px-2 py-1 text-xs hover:border-ink-soft" onClick={() => { setValue('email', email); setValue('password', 'Auctra@2026'); }}>
                {email.split('@')[0]}
              </button>
            ))}
          </div>
        </div>
      )}
    </AuthShell>
  );
}

export function RegisterPage() {
  const { register: signUp, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, formState, setError } = useForm<z.infer<typeof registerSchema>>({ resolver: zodResolver(registerSchema), defaultValues: { role: 'USER' } });
  if (user) return <Navigate to="/" replace />;
  const onSubmit = handleSubmit(async (v) => {
    setFormError(null);
    try {
      await signUp(v);
      navigate((location.state as { from?: string } | null)?.from ?? '/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EMAIL_IN_USE') setError('email', { message: 'An account with this email already exists. Try signing in.' });
      else if (err instanceof ApiError && err.code === 'VALIDATION_ERROR' && Array.isArray(err.details)) {
        for (const d of err.details as { path: string; message: string }[]) setError(d.path as 'email', { message: d.message });
      } else setFormError(errorMessage(err));
    }
  });
  return (
    <AuthShell title="Create your account" subtitle={<>Already bidding? <Link to="/login" className="font-medium text-baize underline underline-offset-4">Sign in</Link></>}>
      <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
        {formError && <p role="alert" className="rounded-md bg-outbid-tint px-3 py-2 text-sm text-outbid">{formError}</p>}
        <Field label="Full name" error={formState.errors.name?.message}>
          {({ id, describedBy }) => <Input id={id} autoComplete="name" aria-describedby={describedBy} aria-invalid={Boolean(formState.errors.name)} {...register('name')} />}
        </Field>
        <Field label="Email" error={formState.errors.email?.message}>
          {({ id, describedBy }) => <Input id={id} type="email" autoComplete="email" aria-describedby={describedBy} aria-invalid={Boolean(formState.errors.email)} {...register('email')} />}
        </Field>
        <Field label="Password" hint="At least 8 characters, with a letter and a number." error={formState.errors.password?.message}>
          {({ id, describedBy }) => <PasswordInput id={id} autoComplete="new-password" aria-describedby={describedBy} aria-invalid={Boolean(formState.errors.password)} {...register('password')} />}
        </Field>
        <fieldset>
          <legend className="text-sm font-medium text-ink-soft">I want to</legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {[['USER', 'Bid on lots'], ['SELLER', 'Bid and sell']].map(([v, label]) => (
              <label key={v} className="flex cursor-pointer items-center gap-2 rounded-md border border-line-strong bg-paper px-3 py-2.5 text-sm has-[:checked]:border-baize has-[:checked]:bg-baize-tint/50">
                <input type="radio" value={v} {...register('role')} className="accent-baize" />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <Button type="submit" size="lg" loading={formState.isSubmitting}>Create account</Button>
      </form>
    </AuthShell>
  );
}
