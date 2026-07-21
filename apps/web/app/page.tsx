import { redirect } from "next/navigation";

export default function Home() {
  // Signed-in users are bounced on to /dashboard from the login page.
  redirect("/login");
}  