async function fetchReactionGif(action) {
  const res = await fetch(`https://nekos.best/api/v2/${action}`, {
    headers: { "User-Agent": "Ceitus/1.0 (+https://github.com/ceitooo/ceitus-viejo)" }
  });
  if (!res.ok) throw new Error(`nekos.best respondiÃ³ ${res.status}`);
  const data = await res.json();
  const result = data.results?.[0];
  if (!result) throw new Error("nekos.best no devolviÃ³ resultados");
  return result;
}

module.exports = { fetchReactionGif };
