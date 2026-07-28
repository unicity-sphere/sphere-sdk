/**
 * Local ESLint rules for comment density.
 *
 * ESLint core covers size and complexity (max-lines, max-lines-per-function,
 * complexity, max-depth, max-params). It has no rule for how much of a file is
 * prose, so these two fill that gap and nothing else. See docs/CODE-STANDARDS.md.
 */

/** A comment run directly above a declaration is API documentation, not inline prose. */
const DECLARATION = /^\s*(?:export|async|private|public|protected|static|readonly|function|class|interface|type|enum|const|let|abstract|declare|@)/;

const commentRatio = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Limit the share of a file that is comments' },
    schema: [{
      type: 'object',
      properties: { max: { type: 'number' } },
      additionalProperties: false,
    }],
    messages: {
      tooMuch: 'File is {{actual}}% comments (max {{max}}%). Move invariants into a test name, history into git, and explanations into a function name.',
    },
  },
  create(context) {
    const max = context.options[0]?.max ?? 0.15;
    return {
      Program(node) {
        const src = context.sourceCode;
        const lines = src.lines;
        const commented = new Set();
        for (const c of src.getAllComments()) {
          for (let l = c.loc.start.line; l <= c.loc.end.line; l++) commented.add(l);
        }
        let code = 0;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trim() && !commented.has(i + 1)) code++;
        }
        const total = code + commented.size;
        if (total === 0) return;
        const ratio = commented.size / total;
        if (ratio > max) {
          context.report({
            node,
            messageId: 'tooMuch',
            data: { actual: Math.round(ratio * 100), max: Math.round(max * 100) },
          });
        }
      },
    };
  },
};

const noLongCommentBlock = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Limit consecutive inline comment lines' },
    schema: [{
      type: 'object',
      properties: { max: { type: 'number' } },
      additionalProperties: false,
    }],
    messages: {
      tooLong: '{{lines}} consecutive comment lines (max {{max}}). A paragraph explaining a block is a function wanting a name.',
    },
  },
  create(context) {
    const max = context.options[0]?.max ?? 5;
    return {
      Program() {
        const src = context.sourceCode;
        const lines = src.lines;
        const comments = src.getAllComments();
        if (!comments.length) return;

        // Group comments into runs of consecutive lines.
        let run = [comments[0]];
        const runs = [];
        for (let i = 1; i < comments.length; i++) {
          const prev = run[run.length - 1];
          if (comments[i].loc.start.line <= prev.loc.end.line + 1) run.push(comments[i]);
          else { runs.push(run); run = [comments[i]]; }
        }
        runs.push(run);

        for (const r of runs) {
          const start = r[0].loc.start.line;
          const end = r[r.length - 1].loc.end.line;
          const height = end - start + 1;
          if (height <= max) continue;

          // Exempt a JSDoc block that documents the declaration below it.
          const isJsdoc = r[0].type === 'Block' && src.getText(r[0]).startsWith('/**');
          const next = lines[end] ?? '';
          if (isJsdoc && DECLARATION.test(next)) continue;

          context.report({
            loc: r[0].loc,
            messageId: 'tooLong',
            data: { lines: height, max },
          });
        }
      },
    };
  },
};

export default {
  rules: {
    'comment-ratio': commentRatio,
    'no-long-comment-block': noLongCommentBlock,
  },
};
