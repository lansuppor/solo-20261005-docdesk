const name = 'docdesk';
const args = process.argv.slice(2);

if (args.length > 0 && !(args.length === 1 && ['--help', '-h'].includes(args[0]))) {
  console.error(name + ': unknown arguments; use --help');
  process.exitCode = 2;
} else {
  console.log(name + '\n\nUsage: node app.js [--help]\n\n团队资料库与文档流转。当前仅提供帮助信息。');
}
