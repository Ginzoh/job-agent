# How to write your CV file

Copy this into `CV_example/` as a `.md` or `.txt` file and replace everything with your own details.

**Only `.md` and `.txt` are read.** Node ships no PDF parser and this project has no
dependencies, so if your real CV is a PDF, keep a text twin beside it and update the twin
whenever the PDF changes — otherwise you'll be tailoring applications from stale facts.

Everything in this file is treated as **ground truth**. The generator is instructed never to
claim anything that isn't here, so anything you leave out will never appear in a generated CV
or cover letter. Err on the side of including more.

---

# FIRSTNAME LASTNAME

**Job title you want to be read as**

City, Country
you@example.com · +00 0 00 00 00 00
GitHub: https://github.com/yourhandle · LinkedIn: https://www.linkedin.com/in/yourhandle

## Profile

Two or three sentences. Your stack, your years of experience, and what you are actually good
at. Written the way you would say it out loud, not the way a CV-advice blog would.

## Experience

### Job Title — Company, City
*Month Year – Month Year*

- What you built, in concrete terms. Name the technologies.
- A thing you owned end to end rather than contributed to.
- A problem you fixed and what it improved. Include a number only if you genuinely have one —
  invented metrics are worse than none, because you have to defend them in an interview.

### Previous Job Title — Company, City
*Month Year – Month Year*

- Same again. Keep the most relevant bullets first within each role.

## Education

### Degree (level)
**Institution | Years**

- Anything notable: specialisation, major project, relevant coursework.

## Projects

### Project name
*Dates*

**Context:** what it was for.

**Technologies:** the actual stack.

**Key achievements:**
- What you built and what worked.

## Technical Skills

**Main languages:** the two or three you would be comfortable being tested on

**Front-end:** frameworks · styling · testing · state management

**Back-end:** runtimes · frameworks · APIs · databases

**Tools & Environment:** version control · CI/CD · containers · cloud · monitoring

**Methodologies:** Agile, CI/CD, whatever you have genuinely worked within

## Languages

- **English:** your real level
- **Other:** your real level

## Interests

- Keep these short. Side projects that show technical range are worth more here than hobbies.

<!--
  ADDITIONAL CONTEXT

  This block is special: unlike other HTML comments in the file, it IS read and treated as
  fact. Use it for true things that don't fit on a one-page PDF but are useful when writing
  an application:

  - Your current status (employed, freelance, between roles, notice period).
  - Why a role ended, if it deserves an explanation — a liquidation or a finished contract is
    context, not a weakness, and it is better addressed head-on than left as a gap.
  - Side projects in detail, especially ones outside your professional stack.
  - Anything you know well but which never made it onto the CV for space reasons.

  Every other HTML comment in this file is ignored, so you can leave notes to yourself freely.
-->
