<?php
// Grady Set Go - Playout App: feedback relay. Upload to your web hosting, set $TO, then put the file's https URL
// into config.json as "feedback_endpoint". Receives JSON from the panel and mails it to $TO. Nothing is stored.
$TO = 'you@example.com';          // where feedback is delivered
$FROM = 'feedback@example.com';   // a mailbox on this same domain (needed by most hosts)
$MAX = 20000;                     // bytes
$LIMIT = 20;                      // messages per hour per visitor address

header('Content-Type: application/json');
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); exit('{"ok":false}'); }
$raw = file_get_contents('php://input', false, null, 0, $MAX + 1);
if ($raw === false || strlen($raw) > $MAX) { http_response_code(413); exit('{"ok":false}'); }
$j = json_decode($raw, true);
if (!is_array($j) || trim((string)($j['message'] ?? '')) === '' || !empty($j['website'])) { http_response_code(400); exit('{"ok":false}'); }

// crude rate limit by caller address, kept in the system temp folder
$f = sys_get_temp_dir() . '/gsg_fb_' . md5($_SERVER['REMOTE_ADDR'] ?? '');
$hits = is_file($f) ? array_filter(array_map('intval', explode(',', (string)file_get_contents($f))), fn($t) => $t > time() - 3600) : [];
if (count($hits) >= $LIMIT) { http_response_code(429); exit('{"ok":false}'); }
$hits[] = time(); file_put_contents($f, implode(',', $hits));

$clean = fn($s, $n) => substr(preg_replace('/[\r\n]+/', ' ', (string)$s), 0, $n);
$subject = '[' . $clean($j['app'] ?? 'App', 60) . ' ' . $clean($j['version'] ?? '', 20) . '] ' . $clean($j['kind'] ?? 'feedback', 20);
$body = substr((string)$j['message'], 0, 8000) . "\n\n---\n" . substr((string)($j['info'] ?? ''), 0, 2000);
$ok = mail($TO, '=?UTF-8?B?' . base64_encode($subject) . '?=', $body, "From: $FROM\r\nContent-Type: text/plain; charset=UTF-8\r\nMIME-Version: 1.0");
http_response_code($ok ? 200 : 500);
echo json_encode(['ok' => $ok]);
