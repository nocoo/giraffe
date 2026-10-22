UPDATE repo_stars
SET source = 'agent'
WHERE account_id IN (SELECT id FROM accounts WHERE lower(login) = 'nocoo')
  AND lower(repo) IN (
    'nocoo/base-ci', 'nocoo/base-cli', 'nocoo/base-mcp',
    'nocoo/diorama-journey', 'nocoo/eagle', 'nocoo/falcon',
    'nocoo/gaga', 'nocoo/hexly.ai', 'nocoo/his.fm',
    'nocoo/kite', 'nocoo/lizheng.dev', 'nocoo/next-ai',
    'nocoo/octo', 'nocoo/rhino', 'nocoo/rio',
    'nocoo/sleepy', 'nocoo/zeppelin', 'nocoo/zoo'
  )
  AND source = 'owner'
  AND starred = 1
  AND reason IS NULL
  AND updated_at = '2026-10-18T12:03:11.294Z';
