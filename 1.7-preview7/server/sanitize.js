// R7/R13：控制字符清理，防止终端注入（ANSI/回车）、日志污染与文件名异常
/* eslint-disable no-control-regex -- 本文件职责就是识别并剥离控制字符 */
// - stripControl：保留 \t \n（消息、公告等多行文本）
// - stripControlSingleLine：去除全部控制字符（用户名/群名/文件名等单行字段）
function stripControl(text) {
  return String(text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

function stripControlSingleLine(text) {
  return String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

module.exports = { stripControl, stripControlSingleLine };
