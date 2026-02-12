const USERNAME = "micky";
const PASSWORD = "stuart2026";

export default function middleware(req) {
  const auth = req.headers.get("authorization");
  if (auth) {
    const decoded = atob(auth.split(" ")[1]);
    const [user, pass] = decoded.split(":");
    if (user === USERNAME && pass === PASSWORD) return;
  }

  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Stuart Dashboard"' },
  });
}

export const config = { matcher: ["/((?!_next).*)"] };
