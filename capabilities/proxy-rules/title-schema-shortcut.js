module.exports = function(ctx) {
  const format = ctx.body.output_config?.format;
  if (!format || format.type !== 'json_schema') return;
  const schema = format.schema;
  if (!schema || schema.type !== 'object') return;
  const props = Object.keys(schema.properties || {});
  if (props.length !== 1 || props[0] !== 'title') return;
  if (schema.additionalProperties !== false) return;
  if (!Array.isArray(schema.required) || schema.required.length !== 1 || schema.required[0] !== 'title') return;

  console.log('[rule:title-schema-shortcut] Title-only json_schema detected — returning dummy');
  ctx.helpers.sendDummyResponse(ctx, {
    text: '{"title":"Dummy (by vistaclair)"}',
  });
  return true;
};
