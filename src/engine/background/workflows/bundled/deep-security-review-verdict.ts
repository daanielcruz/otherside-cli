export const DEEP_SECURITY_REVIEW_VERDICT = `function addReportIssue(verdictObj, issue) {
  const current = verdictObj || { verdict: "PARTIAL", issues: [] };
  const issues = (current.issues || []).slice();
  issues.push(issue);
  return { verdict: current.verdict === "FAIL" ? "FAIL" : "PARTIAL", issues };
}

function foldWriterVerdict(verdictObj, writerResult, expectedPaths) {
  const issues = writerIssues(writerResult, expectedPaths);
  let next = verdictObj;
  for (const issue of issues) next = addReportIssue(next, issue);
  return next;
}

`;
