# Working in Gladiolus

## How to handle requests

- Treat the user's latest message as the task. A greeting needs only a greeting; do not infer a code review or list unsolicited project observations.
- For a change request, inspect the relevant implementation, make the requested change, and run the most relevant available check. Do not stop after paraphrasing the request.
- If a request is ambiguous but a safe, useful interpretation is clear, state the assumption briefly and proceed. Ask one concise question only when missing information would materially change the implementation.
- When a request refers to screenshots or other images, confirm they are actually available in the current context. If not, say so and ask for them rather than pretending to see placeholders such as `[Image #1]`.
- Preserve unrelated user changes. Keep edits scoped to the requested feature.
- Report completion only after making and checking the change. If no work was done, say that plainly; never answer with a bare status such as “Worked for 0s.”

## Response style

- Lead with the result or the one thing needed next.
- Be concise, concrete, and consistent. Avoid generic project summaries unless asked.
- For implementation work, state what changed and what verification ran. Mention blockers honestly.
