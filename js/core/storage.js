import { exportAll, importAll } from './db.js';

export async function exportBackup() {
  const data = await exportAll();
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `glory-phone-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function importBackup() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async e => {
      const file = e.target.files[0];
      if (!file) return reject(new Error('未选择文件'));
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        await importAll(data);
        resolve(true);
      } catch (err) {
        reject(err);
      }
    };
    input.click();
  });
}
