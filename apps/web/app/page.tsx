import { redirect } from "next/navigation";

export default function Home() {
  // No dashboard yet — the admin panel starts at sign-in.
  redirect("/login"); 
}