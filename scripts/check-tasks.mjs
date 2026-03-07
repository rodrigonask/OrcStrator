const resp = await fetch('http://localhost:3333/api/pipelines');
const data = await resp.json();
for (const [projectId, tasks] of Object.entries(data)) {
  for (const t of tasks) {
    if (t.column !== 'done') {
      console.log(t.column.padEnd(10), t.lockedBy ? 'LOCKED:' + t.lockedBy.slice(0,8) : 'free    ', t.title.slice(0,60));
    }
  }
}
