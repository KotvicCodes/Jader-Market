import Link from "next/link";

export default function NotFound() {
  return <div className="empty"><h1>Market or page not found</h1><p>This page does not exist or is not publicly available.</p><Link href="/">Back to markets</Link></div>;
}
