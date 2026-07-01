import { redirect } from "next/navigation";

// Sign-up is disabled on this single-user deployment (see the signIn
// callback in lib/auth/config.ts and the disabled register route). Any
// visit to /signup just bounces to the Google-only login page.
export default function SignupPage() {
  redirect("/login");
}
