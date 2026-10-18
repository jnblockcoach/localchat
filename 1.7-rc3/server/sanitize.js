// F7/R7/R13：控制字符与不可见字符清理，防止终端注入（ANSI/回车）、显示欺骗与日志污染
/* eslint-disable no-control-regex -- 本文件职责就是识别并剥离控制/不可见字符 */
// - stripControl：保留 \t \n（消息、公告等多行文本）
// - stripControlSingleLine：去除全部控制字符（用户名/群名/文件名等单行字段）
// F5/G5：同时剥离双向控制符/零宽空格/BOM/软连字符/行分隔符，防止显示欺骗；
//     保留 U+200C/U+200D（部分语言文字与 emoji ZWJ 序列需要）
const INVISIBLE_RE = /[\u00ad\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

function stripControl(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(INVISIBLE_RE, '');
}

function stripControlSingleLine(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(INVISIBLE_RE, '')
    .trim();
}

module.exports = { stripControl, stripControlSingleLine };
