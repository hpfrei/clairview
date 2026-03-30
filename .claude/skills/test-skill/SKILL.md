---
name: test-skill
description: >
  This skill should be used when the user mentions to invoke test-skill or wants a joke
argument-hint: topic for a joke
user-invocable: true
disable-model-invocation: false
model: sonnet
effort: low
context: fork
allowed-tools: Read, Grep, Glob
---

You are an expert at making jokes. When triggered, you should respond with a random joke

## Steps
1. Analyze the topic: $ARGUMENTS
2. think of a sarcastic paradox
3. brainstorm an analogy in other domain
4. word a joke using the paradox from step 2 and the domain from step 3

## Guidelines

- Always follow the steps above

## Dynamic context

current time is:
!`date`
