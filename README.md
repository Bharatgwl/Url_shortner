# URL Shortener

A learning project built with Node.js, Express, and MySQL. It creates short links for HTTPS URLs and redirects visitors to the saved destination.

## Features

- Six-character random codes using uppercase letters, lowercase letters, and digits.
- Case-sensitive codes: `ntGn2e` and `ntGn2E` are different.
- Persistent URL mappings in MySQL.
- Up to five insert attempts when generated codes collide.
- HTTPS destination validation and parameterized database queries.
- A new short link for every submission; existing links keep working.

## Requirements

- Node.js with ES module and top-level await support, and npm.
- A running MySQL server; MySQL Workbench is optional.
- Globally installed nodemon if using `npm run dev`.

## Setup

### 1. Install dependencies

Open a terminal in the project folder and run:

```sh
npm install
```

### 2. Set up MySQL

For a fresh database, run the following in MySQL Workbench or another SQL client. If your database and table already exist, skip this step.

```sql
CREATE DATABASE url_shortner;
USE url_shortner;

CREATE TABLE links (
    shortcode VARCHAR(6) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    original_url TEXT NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (shortcode)
);
```

The primary key prevents duplicate codes. The `ascii_bin` collation makes code comparisons case-sensitive. The application generates exactly six characters; `VARCHAR(6)` itself sets only a maximum length.

### 3. Configure environment variables

Create `.env` in the project root. Replace the placeholder credentials with your local MySQL details:

```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=your_mysql_user
DB_PASSWORD="your_mysql_password"
DB_NAME=url_shortner
BASE_URL=http://localhost:8000
```

Use no trailing slash in `BASE_URL`. The server currently listens on the hardcoded port `8000`; changing `BASE_URL` changes returned links, not the listening port.

Keep `.env` and `node_modules/` in `.gitignore`. Never commit actual credentials.

### 4. Start the server

```sh
npm run dev
```

This uses globally installed nodemon to restart the server when files change. To run without nodemon:

```sh
node server.js
```

The server checks MySQL before listening. On success, the terminal displays:

```text
Database connected
Server listening on 8000
```

## API

### Health check

`GET /health`

Returns `200 OK` with the text `OK`. This checks that the HTTP server responds; it does not perform a new database check.

### Create a short link

`POST /links`

Send JSON with the header `Content-Type: application/json`:

```json
{
  "original_url": "https://example.com/articles/introduction-to-system-design"
}
```

Example response: `201 Created`.

```json
{
  "short_url": "http://localhost:8000/abc123"
}
```

The code is generated randomly, so your response will differ.

| Status | Meaning |
| --- | --- |
| 201 | Mapping saved and short URL returned. |
| 400 | Missing, empty, non-string, invalid, or non-HTTPS destination. |
| 500 | Database operation failed or all five code attempts collided. |

The server stores the parsed URL's `href`. It validates URL structure and HTTPS usage; it does not check whether the destination is reachable or trustworthy.

### Open a short link

`GET /:code`

Example: `GET /abc123`.

| Status | Meaning |
| --- | --- |
| 302 | Original URL returned in the `Location` header; the browser follows it. |
| 404 | No mapping exists for that code. |
| 500 | Database lookup failed. |

`/health` is a reserved route. The application server must be running for short links to redirect.

## Request flows

**Create:** client sends URL -> server validates -> generates code -> inserts mapping -> returns short URL. A duplicate code triggers another attempt, up to five total attempts.

**Open:** browser sends code -> server looks it up in MySQL -> returns a redirect or 404 -> browser requests the destination website.

## Manual verification

Use Thunder Client in VS Code for POST requests and a browser for redirects.

- Create a link for a valid HTTPS URL: expect 201 and a saved database row.
- Open the returned link: expect a redirect to the destination.
- Submit HTTP URLs, random text, empty input, and a missing field: expect 400.
- Request an unknown code: expect 404.
- Submit the same destination twice: expect different short links that both work.
- Change the case of a code: expect 404 unless that exact other code exists.
- Restart the server and open a saved link: it should still work.
- Temporarily force an existing code for all five attempts: expect 500 and no overwritten mapping.
- Temporarily generate an existing code followed by an unused code: expect 201 with the unused code.

Restore normal random generation after collision testing. There is currently no automated test suite; `npm test` is the default placeholder and exits with an error.

## Current limits and future work

This is a local learning version with one application server and one MySQL database. `localhost` links refer to the visitor's own computer and are not public shareable links.

Future improvements include automated tests, deployment, rate limiting, abuse controls, analytics, expiry, caching, and measured scaling. There are currently no user accounts, QR codes, or destination safety checks. Code generation uses `Math.random()`; short codes should not be treated as secrets or access controls.
