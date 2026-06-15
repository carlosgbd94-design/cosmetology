import urllib.request
try:
    content = urllib.request.urlopen('https://carlosgbd94-design.github.io/cosmetology/').read().decode()
    if 'main.tsx' in content:
        print("Still serving raw index.html (contains main.tsx)")
    elif 'assets/index' in content:
        print("Serving compiled index.html (contains assets/index)")
    else:
        print("Serving something else")
except Exception as e:
    print(e)
