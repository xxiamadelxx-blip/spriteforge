const hook = 'https://api.codemagic.io/hooks/6aa6542caf15c45faf8dbe96';
const targetSha = 'bbec472425dc02ed3b7eb496926e2a15e69f62e2';

const payload = {
  ref: 'refs/heads/ci/android-build',
  before: '0000000000000000000000000000000000000000',
  after: targetSha,
  repository: {
    full_name: 'xxiamadelxx-blip/-remote',
    name: '-remote',
    html_url: 'https://github.com/xxiamadelxx-blip/-remote',
    clone_url: 'https://github.com/xxiamadelxx-blip/-remote.git',
    ssh_url: 'git@github.com:xxiamadelxx-blip/-remote.git',
    default_branch: 'main',
  },
  head_commit: {
    id: targetSha,
    message: 'ci: build split-brain recovery candidate',
  },
  commits: [{
    id: targetSha,
    message: 'ci: build split-brain recovery candidate',
  }],
  pusher: { name: 'xxiamadelxx-blip' },
  sender: { login: 'xxiamadelxx-blip' },
};

try {
  const response = await fetch(hook, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-github-delivery': `render-rescue-${Date.now()}`,
      'user-agent': 'ORemote-Render-Webhook-Rescue/1.0',
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  console.log(`Codemagic rescue webhook status=${response.status} body=${text.slice(0, 500)}`);
} catch (error) {
  console.warn(`Codemagic rescue webhook failed: ${error?.message || error}`);
}
