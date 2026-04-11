# @ryan_nookpi/pi-extension-ask-user-question

Interactive multi-question form tool for pi.

After installation, pi can use the `ask_user_question` tool to collect structured input from the user with:

- `radio` questions for single choice
- `checkbox` questions for multiple choice
- `text` questions for free-form answers
- optional `Other...` inputs for custom answers

## Install

```bash
pi install npm:@ryan_nookpi/pi-extension-ask-user-question
```

## Example

```json
{
  "title": "Deployment settings",
  "description": "Need a few decisions before continuing.",
  "questions": [
    {
      "id": "env",
      "type": "radio",
      "prompt": "Which environment should I use?",
      "options": [
        { "value": "staging", "label": "Staging" },
        { "value": "prod", "label": "Production" }
      ]
    },
    {
      "id": "notes",
      "type": "text",
      "prompt": "Anything else I should know?",
      "required": false,
      "placeholder": "Optional notes"
    }
  ]
}
```
