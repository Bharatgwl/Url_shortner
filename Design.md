**My URL shortener uses Node.js and PostgreSQL.**
**The database stores a short code, its original URL, and the creation time.**
**Every short code must be unique.**
**Multiple short codes can point to the same original URL.**

### Creating a short link
1. Receive the original URL.
2. Check that it is a valid HTTPS URL.
3. Generate a random six-character code.
4. Save the code and original URL in PostgreSQL. If the code already exists, retry with another code.
5. Return http://localhost:8000/ followed by the code.
### Opening a short link
1. Receive the short code.
2. Find its original URL in PostgreSQL.
3. If found, redirect with 302.
4. If missing, return 404.


| Action | Endpoint | What happens |
|--------|----------|--------------|
| Create a short link | `POST /links` | Receives `original_url`; returns `short_url` with status `201` |
| Open a short link | `GET /{code}` | Finds the code; returns `302` redirect or `404` |


Start a Node.js server.
[ ] Create the PostgreSQL links table.
[ ] Connect the server to PostgreSQL.
[ ] Implement creating a short link.
[ ] Implement redirecting a short link.
[ ] Check valid URLs, invalid URLs, unknown codes, and links after restarting.