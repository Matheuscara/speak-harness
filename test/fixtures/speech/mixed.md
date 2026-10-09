Fiz o merge da branch e abri o PR com o changelog atualizado, mas o deploy no pipeline de CI ainda falha no step de build.

The error message says the cache key is missing from the environment, which means the runner cannot restore the dependencies.

Então o próximo passo é configurar a variável no workflow e rodar o job de novo.
