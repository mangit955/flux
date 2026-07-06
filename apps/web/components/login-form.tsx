"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

export function LoginForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [guestLoading, setGuestLoading] = useState(false);
  const router = useRouter();
  const { login, loginAsGuest } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await login(email, password);
      router.push("/trade");
    } catch (err: any) {
      setError(err.message || "Invalid email or password");
    } finally {
      setLoading(false);
    }
  };

  const handleGuestLogin = async () => {
    setError("");
    setGuestLoading(true);

    try {
      await loginAsGuest();
      router.push("/trade");
    } catch (err: any) {
      setError(err.message || "Unable to start a guest session");
    } finally {
      setGuestLoading(false);
    }
  };

  const isBusy = loading || guestLoading;

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <form onSubmit={handleSubmit}>
        <FieldGroup>
          <div className="flex flex-col items-center gap-2 text-center">
            <Link
              href="/"
              className="flex flex-col items-center gap-2 font-medium"
            >
              <div className="flex size-8 items-center justify-center rounded-md">
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 26 26"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  <rect
                    x="3"
                    y="6"
                    width="4"
                    height="15"
                    rx="2"
                    fill="white"
                    transform="rotate(-18 3 6)"
                  />
                  <rect
                    x="10.5"
                    y="3"
                    width="4"
                    height="18"
                    rx="2"
                    fill="white"
                    transform="rotate(-18 10.5 3)"
                  />
                  <rect
                    x="18"
                    y="1"
                    width="4"
                    height="21"
                    rx="2"
                    fill="white"
                    opacity="0.35"
                    transform="rotate(-18 18 1)"
                  />
                </svg>
              </div>
              <span className="sr-only">Flex</span>
            </Link>
            <h1 className="text-xl font-bold">Welcome back to Flex</h1>
            <FieldDescription>
              Don&apos;t have an account?{" "}
              <Link
                href="/signup"
                className="hover:text-white! hover:underline! underline!"
              >
                Sign up
              </Link>
            </FieldDescription>
          </div>
          
          {error && (
            <div className="text-sm font-medium text-red-500 text-center bg-red-500/10 py-2 rounded-md">
              {error}
            </div>
          )}

          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              id="email"
              type="email"
              placeholder="m@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isBusy}
              required
            />

            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input
              id="password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isBusy}
              required
            />
          </Field>
          <Field>
            <Button type="submit" disabled={isBusy}>
              {loading ? "Logging in..." : "Login"}
            </Button>
          </Field>
          <FieldSeparator>Or</FieldSeparator>
          <Field>
            <Button
              variant="secondary"
              type="button"
              disabled={isBusy}
              onClick={handleGuestLogin}
            >
              {guestLoading ? "Starting guest session..." : "Continue as guest"}
            </Button>
          </Field>
          <Field className="grid gap-4 sm:grid-cols-2">
            <Button variant="outline" type="button" disabled={isBusy}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                <path
                  d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"
                  fill="currentColor"
                />
              </svg>
              Continue with Apple
            </Button>
            <Button variant="outline" type="button" disabled={isBusy}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                <path
                  d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"
                  fill="currentColor"
                />
              </svg>
              Continue with Google
            </Button>
          </Field>
        </FieldGroup>
      </form>
      <FieldDescription className="px-6 text-center">
        By clicking continue, you agree to our <a href="#">Terms of Service</a>{" "}
        and <a href="#">Privacy Policy</a>.
      </FieldDescription>
    </div>
  );
}
