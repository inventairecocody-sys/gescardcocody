const bcrypt = require('bcrypt');

const passwords = [
  'Univ!Admin1',
  'Univ!Super1',
  'Univ!Chef1',
  'Univ!Oper1',
  'CHU!Chef2',
  'CHU!Oper2',
  'Lycée!Chef3',
  'Lycée!Oper3',
  'Binge!Chef4',
  'Binge!Oper4',
  'Adj!Chef5',
  'Adj!Oper5'
];

async function run() {
  for (const pw of passwords) {
    const hash = await bcrypt.hash(pw, 10);
    console.log(`${pw} -> ${hash}`);
  }
}

run();