/**
 * Freestyle has no sign-in, so there is nothing to gate. This stays as the
 * single place dashboard routes would be protected.
 */
export function LoginGate({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return <>{children}</>;
}
