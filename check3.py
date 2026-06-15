import urllib.request
try:
    print(urllib.request.urlopen('https://carlosgbd94-design.github.io/cosmetology/').read().decode()[:500])
except Exception as e:
    print(e)
